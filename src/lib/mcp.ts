import http from "node:http";
import https from "node:https";
import { jsonSchema, tool, type ToolSet } from "ai";
import { hasUnknownWriteOutcome, unknownWriteResult } from "@/lib/mcp-outcome";
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
  annotations?: {
    idempotentHint?: boolean;
    readOnlyHint?: boolean;
    [key: string]: unknown;
  };
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
  accessToken: string;
  fetchedAt: number;
  requireWriteApproval: boolean;
  tools: ToolSet;
  readToolNames: string[];
};

type McpMethodResponse<T> = {
  result: T;
  sessionHeaderId: string | null;
};

type CachedMcpSession = {
  expiresAt: number;
  protocolVersion: string;
  sessionId: string;
};

type InitializedMcpSession = {
  protocolVersion: string;
  sessionId: string | null;
};

type McpInitializeResult = {
  protocolVersion?: string;
};

export class McpHttpError extends Error {
  constructor(public readonly status: number) {
    super(`MCP request failed with status ${status}`);
  }
}

class McpRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

// One exchange owns this queue, so cached tools never share recovery state.
export function createMcpExecution(signal?: AbortSignal) {
  let uncertain = false;
  let queue = Promise.resolve();
  return {
    hasUnknownOutcome: () => uncertain,
    wrap: (tools: ToolSet, readToolNames: string[]): ToolSet => Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute || readToolNames.includes(name)) return [name, definition];
        return [name, {
          ...definition,
          execute: (input, options) => {
            const result = queue.then(async () => {
              if (signal?.aborted) return stoppedWriteResult();
              if (uncertain) return {
                isError: true,
                content: [{ type: "text", text: "Not executed because an earlier TYPO3 write outcome is unknown." }],
                _meta: { operation: "write", outcome: "blocked" },
              };
              const output = await execute(input, signal ? {
                ...options,
                abortSignal: options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal,
              } : options);
              uncertain ||= hasUnknownWriteOutcome(output);
              return output;
            });
            queue = result.then(() => undefined, () => undefined);
            return result;
          },
        } satisfies ToolSet[string]];
      }),
    ),
  };
}

function stoppedWriteResult() {
  return {
    isError: true,
    content: [{ type: "text", text: "Not executed because generation was stopped." }],
    _meta: { operation: "write", outcome: "blocked" },
  };
}

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const MCP_SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const MCP_SESSION_CACHE_TTL_MS = 25 * 60 * 1000;
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
  let url: URL;
  try {
    url = new URL("/typo3/record/edit", env.TYPO3_BASE_URL);
  } catch {
    return null;
  }
  url.searchParams.set(`edit[${table}][${uid}]`, "edit");
  url.searchParams.set("returnUrl", "/typo3/module/web/layout");
  return url.toString();
}

export function classifyMcpTool(
  toolDefinition: Pick<McpToolDefinition, "annotations">,
): "read" | "write" {
  return toolDefinition.annotations?.readOnlyHint === true ? "read" : "write";
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

        response.once("error", fail);
        response.once("aborted", () => fail(new Error("MCP response aborted")));

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
      const error = getAbortReason(signal);
      fail(error);
      request.destroy(error);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abortRequest);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    request.once("error", fail);
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

function getCachedMcpSession(
  cacheKey: string,
  now = Date.now(),
): CachedMcpSession | null {
  const cached = mcpSessionCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= now) {
    mcpSessionCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function setCachedMcpSession(
  cacheKey: string,
  session: {
    protocolVersion: string;
    sessionId: string;
  },
  now = Date.now(),
): void {
  mcpSessionCache.set(cacheKey, {
    expiresAt: now + MCP_SESSION_CACHE_TTL_MS,
    ...session,
  });
}

async function callMcpMethod<T>({
  accessToken,
  method,
  params,
  protocolVersion,
  sessionHeaderId,
}: {
  accessToken: string;
  method: string;
  params?: Record<string, unknown>;
  protocolVersion?: string | null;
  sessionHeaderId?: string | null;
}): Promise<McpMethodResponse<T>> {
  const mcpUrl = getTypo3McpUrl();
  const response = await withMcpRequestTimeout((signal) =>
    postJson(
      mcpUrl,
      {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(protocolVersion
          ? { "MCP-Protocol-Version": protocolVersion }
          : {}),
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
    throw new McpRpcError(payload.error.code, payload.error.message);
  }

  return {
    result: payload.result,
    sessionHeaderId: response.headers.get("mcp-session-id"),
  };
}

export async function testMcpConnection(accessToken: string): Promise<number> {
  const mcpSession = await initializeMcp(accessToken);
  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    protocolVersion: mcpSession?.protocolVersion,
    sessionHeaderId: mcpSession?.sessionId,
  });

  return listResponse.result.tools.length;
}

async function initializeMcp(
  accessToken: string,
): Promise<InitializedMcpSession | null> {
  try {
    const response = await callMcpMethod<McpInitializeResult>({
      accessToken,
      method: "initialize",
      params: {
        protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "text-to-typo3",
          version: "0.1.0",
        },
      },
    });
    return {
      protocolVersion:
        typeof response.result.protocolVersion === "string"
          ? response.result.protocolVersion
          : MCP_SUPPORTED_PROTOCOL_VERSION,
      sessionId: response.sessionHeaderId,
    };
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
  execution,
}: {
  sessionId: string;
  accessToken: string;
  requireWriteApproval?: boolean;
  execution?: ReturnType<typeof createMcpExecution>;
}): Promise<ToolSet> {
  const toolCacheKey = sessionId;
  const cached = toolCache.get(toolCacheKey);
  const now = Date.now();

  if (cached && cached.accessToken !== accessToken) {
    toolCache.delete(toolCacheKey);
    mcpSessionCache.delete(sessionId);
  } else if (
    cached?.requireWriteApproval !== undefined &&
    cached.requireWriteApproval !== requireWriteApproval
  ) {
    toolCache.delete(toolCacheKey);
  } else if (cached && now - cached.fetchedAt < TOOL_CACHE_TTL_MS) {
    return execution ? execution.wrap(cached.tools, cached.readToolNames) : cached.tools;
  }

  let mcpSession = getCachedMcpSession(sessionId, now);

  if (!mcpSession) {
    const initializedSession = await initializeMcp(accessToken);
    if (initializedSession?.sessionId) {
      mcpSession = {
        expiresAt: now + MCP_SESSION_CACHE_TTL_MS,
        protocolVersion: initializedSession.protocolVersion,
        sessionId: initializedSession.sessionId,
      };
      setCachedMcpSession(sessionId, mcpSession, now);
    }
  }

  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    protocolVersion: mcpSession?.protocolVersion,
    sessionHeaderId: mcpSession?.sessionId,
  });
  const activeMcpSessionId = listResponse.sessionHeaderId ?? mcpSession?.sessionId;
  const activeProtocolVersion =
    mcpSession?.protocolVersion ?? MCP_SUPPORTED_PROTOCOL_VERSION;

  if (activeMcpSessionId) {
    setCachedMcpSession(sessionId, {
      protocolVersion: activeProtocolVersion,
      sessionId: activeMcpSessionId,
    });
  }

  const tools = Object.fromEntries(
    listResponse.result.tools.map((mcpTool) => {
      const operation = classifyMcpTool(mcpTool);

      return [
        mcpTool.name,
        tool({
          description: mcpTool.description || `TYPO3 MCP tool: ${mcpTool.name}`,
          needsApproval: requireWriteApproval && operation === "write",
          inputSchema: jsonSchema(
            (mcpTool.inputSchema as Record<string, unknown>) || {
              type: "object",
              additionalProperties: true,
            },
          ),
          execute: async (input, { abortSignal }) => {
            let executeMcpSession = getCachedMcpSession(sessionId);

            if (!executeMcpSession && activeMcpSessionId) {
              const initializedSession = await initializeMcp(accessToken);
              if (initializedSession?.sessionId) {
                executeMcpSession = {
                  expiresAt: Date.now() + MCP_SESSION_CACHE_TTL_MS,
                  protocolVersion: initializedSession.protocolVersion,
                  sessionId: initializedSession.sessionId,
                };
                setCachedMcpSession(sessionId, executeMcpSession);
              }
            }

            if (operation === "write" && abortSignal?.aborted) return stoppedWriteResult();

            let result: McpMethodResponse<McpToolResult>;
            try {
              result = await callMcpMethod<McpToolResult>({
                accessToken,
                method: "tools/call",
                params: {
                  name: mcpTool.name,
                  arguments: input,
                },
                protocolVersion: executeMcpSession?.protocolVersion,
                sessionHeaderId: executeMcpSession?.sessionId,
              });
              if (!result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
                throw new Error("Invalid MCP tool result");
              }
            } catch (error) {
              if (operation === "read") throw error;
              if (error instanceof McpRpcError && error.code === -32602) {
                return {
                  isError: true,
                  content: [{ type: "text", text: error.message }],
                  _meta: { operation, outcome: "rejected" },
                };
              }
              return unknownWriteResult();
            }

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
      ];
    }),
  );

  const readToolNames = listResponse.result.tools
    .filter((definition) => classifyMcpTool(definition) === "read")
    .map((definition) => definition.name);
  toolCache.set(toolCacheKey, { accessToken, fetchedAt: now, requireWriteApproval, tools, readToolNames });
  return execution ? execution.wrap(tools, readToolNames) : tools;
}

export async function listMcpToolNamesByOperation({
  accessToken,
}: {
  accessToken: string;
}): Promise<Record<"read" | "write", string[]>> {
  const mcpSession = await initializeMcp(accessToken);
  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    protocolVersion: mcpSession?.protocolVersion,
    sessionHeaderId: mcpSession?.sessionId,
  });

  return listResponse.result.tools.reduce<Record<"read" | "write", string[]>>(
    (toolNames, mcpTool) => {
      toolNames[classifyMcpTool(mcpTool)].push(mcpTool.name);
      return toolNames;
    },
    { read: [], write: [] },
  );
}
