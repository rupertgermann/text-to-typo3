import http from "node:http";
import https from "node:https";
import { jsonSchema, tool, type ToolSet } from "ai";
import { getEnv } from "@/lib/env";

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpToolListResult = {
  tools: McpToolDefinition[];
};

type McpToolResult = {
  content?: unknown;
  [key: string]: unknown;
};

type CachedToolSet = {
  fetchedAt: number;
  requireWriteApproval: boolean;
  tools: ToolSet;
};

type McpMethodResponse<T> = {
  result: T;
  sessionHeaderId: string | null;
};

type CachedMcpSession = {
  expiresAt: number;
  sessionId: string;
};

export class McpHttpError extends Error {
  constructor(public readonly status: number) {
    super(`MCP request failed with status ${status}`);
  }
}

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const MCP_SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const MCP_REQUEST_TIMEOUT_MS = 5_000;
const toolCache = new Map<string, CachedToolSet>();
const mcpSessionCache = new Map<string, CachedMcpSession>();

export function resetMcpCachesForTests(): void {
  toolCache.clear();
  mcpSessionCache.clear();
}

export function getTypo3McpUrl(): string {
  const env = getEnv();
  const baseUrl = env.TYPO3_MCP_URL || `${env.TYPO3_BASE_URL}/mcp`;

  if (!env.TYPO3_MCP_ACCESS_TOKEN) {
    return baseUrl;
  }

  const url = new URL(baseUrl);

  if (!url.searchParams.has("token")) {
    url.searchParams.set("token", env.TYPO3_MCP_ACCESS_TOKEN);
  }

  return url.toString();
}

function buildBackendRecordUrl(output: unknown): string | null {
  if (!output || typeof output !== "object") {
    return null;
  }

  const record = output as Record<string, unknown>;
  const table =
    typeof record.table === "string"
      ? record.table
      : typeof record.tablename === "string"
        ? record.tablename
        : typeof record.recordTable === "string"
          ? record.recordTable
          : null;

  const uidValue =
    record.uid ??
    record.id ??
    record.recordUid ??
    record.workspaceUid ??
    record.newUid;

  const uid = typeof uidValue === "number" || typeof uidValue === "string"
    ? String(uidValue)
    : null;

  if (!table || !uid) {
    return null;
  }

  const env = getEnv();
  const url = new URL("/typo3/record/edit", env.TYPO3_BASE_URL);
  url.searchParams.set(`edit[${table}][${uid}]`, "edit");
  url.searchParams.set("returnUrl", "/typo3/module/web/layout");
  return url.toString();
}

export function classifyMcpTool(name: string): "read" | "write" | "unknown" {
  if (/write|create|update|delete|translate/i.test(name)) {
    return "write";
  }

  if (/get|read|search|list/i.test(name)) {
    return "read";
  }

  return "unknown";
}

function shouldAllowInsecureTls(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".ddev.site") ||
    hostname.endsWith(".test")
  );
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<{
  status: number;
  headers: Headers;
  body: string;
}> {
  const parsedUrl = new URL(url);
  const allowInsecureTls = parsedUrl.protocol === "https:" && shouldAllowInsecureTls(parsedUrl);

  if (!allowInsecureTls) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  }

  const transport = parsedUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const request = transport.request(
      parsedUrl,
      {
        method: "POST",
        headers,
        ...(parsedUrl.protocol === "https:"
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on("end", () => {
          const normalizedHeaders: [string, string][] =
            Object.entries(response.headers).flatMap(([key, value]) => {
              if (Array.isArray(value)) {
                return value.map((entry) => [key, entry] as [string, string]);
              }

              return value ? [[key, value] as [string, string]] : [];
            });

          cleanup();
          resolve({
            status: response.statusCode ?? 500,
            headers: new Headers(normalizedHeaders),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const abortRequest = () => {
      request.destroy(getAbortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abortRequest);
    };

    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    signal.addEventListener("abort", abortRequest, { once: true });
    request.write(body);
    request.end();
  });
}

async function withMcpRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(createMcpTimeoutError());
  }, MCP_REQUEST_TIMEOUT_MS);

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function createMcpTimeoutError(): Error {
  const error = new Error("MCP request timed out");
  error.name = "AbortError";
  return error;
}

function getAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createMcpTimeoutError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getCachedMcpSessionId(cacheKey: string, now = Date.now()): string | null {
  const cached = mcpSessionCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    mcpSessionCache.delete(cacheKey);
    return null;
  }

  return cached.sessionId;
}

function setCachedMcpSessionId(
  cacheKey: string,
  sessionId: string,
  now = Date.now(),
): void {
  mcpSessionCache.set(cacheKey, {
    expiresAt: now + MCP_SESSION_CACHE_TTL_MS,
    sessionId,
  });
}

async function callMcpMethod<T>({
  accessToken,
  method,
  params,
  sessionHeaderId,
}: {
  accessToken: string;
  method: string;
  params?: Record<string, unknown>;
  sessionHeaderId?: string | null;
}): Promise<McpMethodResponse<T>> {
  const mcpUrl = getTypo3McpUrl();
  const response = await withMcpRequestTimeout((signal) =>
    postJson(
      mcpUrl,
      {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(sessionHeaderId ? { "Mcp-Session-Id": sessionHeaderId } : {}),
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
      signal,
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    throw new McpHttpError(response.status);
  }

  const payload = JSON.parse(response.body) as JsonRpcSuccess<T> | JsonRpcError;

  if ("error" in payload) {
    throw new Error(payload.error.message);
  }

  return {
    result: payload.result,
    sessionHeaderId: response.headers.get("mcp-session-id"),
  };
}

export async function testMcpConnection(accessToken: string): Promise<number> {
  const mcpSessionId = await initializeMcp(accessToken);
  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    sessionHeaderId: mcpSessionId,
  });

  return listResponse.result.tools.length;
}

async function initializeMcp(accessToken: string): Promise<string | null> {
  try {
    const response = await callMcpMethod({
      accessToken,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "text-to-typo3",
          version: "0.1.0",
        },
      },
    });
    return response.sessionHeaderId;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    // Some servers accept direct tools/list calls without initialize.
    return null;
  }
}

export async function getMcpTools({
  sessionId,
  accessToken,
  requireWriteApproval = true,
}: {
  sessionId: string;
  accessToken: string;
  requireWriteApproval?: boolean;
}): Promise<ToolSet> {
  const toolCacheKey = sessionId;
  const cached = toolCache.get(toolCacheKey);
  const now = Date.now();

  if (
    cached?.requireWriteApproval !== undefined &&
    cached.requireWriteApproval !== requireWriteApproval
  ) {
    toolCache.delete(toolCacheKey);
  } else if (cached && now - cached.fetchedAt < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }

  let mcpSessionId = getCachedMcpSessionId(sessionId, now);

  if (!mcpSessionId) {
    mcpSessionId = await initializeMcp(accessToken);
    if (mcpSessionId) {
      setCachedMcpSessionId(sessionId, mcpSessionId, now);
    }
  }

  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    sessionHeaderId: mcpSessionId,
  });
  const activeMcpSessionId = listResponse.sessionHeaderId ?? mcpSessionId;

  if (activeMcpSessionId) {
    setCachedMcpSessionId(sessionId, activeMcpSessionId);
  }

  const tools = Object.fromEntries(
    listResponse.result.tools.map((mcpTool) => [
      mcpTool.name,
      tool({
        description: mcpTool.description || `TYPO3 MCP tool: ${mcpTool.name}`,
        needsApproval:
          requireWriteApproval && classifyMcpTool(mcpTool.name) === "write",
        inputSchema: jsonSchema(
          (mcpTool.inputSchema as Record<string, unknown>) || {
            type: "object",
            additionalProperties: true,
          },
        ),
        execute: async (input) => {
          let executeMcpSessionId = getCachedMcpSessionId(sessionId);

          if (!executeMcpSessionId && activeMcpSessionId) {
            executeMcpSessionId = await initializeMcp(accessToken);
            if (executeMcpSessionId) {
              setCachedMcpSessionId(sessionId, executeMcpSessionId);
            }
          }

          const result = await callMcpMethod<McpToolResult>({
            accessToken,
            method: "tools/call",
            params: {
              name: mcpTool.name,
              arguments: input,
            },
            sessionHeaderId: executeMcpSessionId,
          });

          const operation = classifyMcpTool(mcpTool.name);
          const backendRecordUrl =
            operation === "write" ? buildBackendRecordUrl(result.result) : null;

          return {
            ...result.result,
            _meta: {
              operation,
              backendRecordUrl,
              approval:
                operation === "write" && !requireWriteApproval
                  ? "auto-approved"
                  : undefined,
            },
          };
        },
      }),
    ]),
  );

  toolCache.set(toolCacheKey, { fetchedAt: now, requireWriteApproval, tools });
  return tools;
}

export async function listMcpToolNamesByOperation({
  accessToken,
}: {
  accessToken: string;
}): Promise<Record<"read" | "write" | "unknown", string[]>> {
  const mcpSessionId = await initializeMcp(accessToken);
  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    sessionHeaderId: mcpSessionId,
  });

  return listResponse.result.tools.reduce<Record<"read" | "write" | "unknown", string[]>>(
    (toolNames, mcpTool) => {
      toolNames[classifyMcpTool(mcpTool.name)].push(mcpTool.name);
      return toolNames;
    },
    { read: [], write: [], unknown: [] },
  );
}
