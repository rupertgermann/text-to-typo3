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
  tools: ToolSet;
};

type McpMethodResponse<T> = {
  result: T;
  sessionHeaderId: string | null;
};

export class McpHttpError extends Error {
  constructor(public readonly status: number) {
    super(`MCP request failed with status ${status}`);
  }
}

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const toolCache = new Map<string, CachedToolSet>();
const mcpSessionCache = new Map<string, string>();

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

function classifyTool(name: string): "read" | "write" | "unknown" {
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
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
  }

  const transport = parsedUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
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

          resolve({
            status: response.statusCode ?? 500,
            headers: new Headers(normalizedHeaders),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.write(body);
    request.end();
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
  const response = await postJson(
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
  } catch {
    // Some servers accept direct tools/list calls without initialize.
    return null;
  }
}

export async function getMcpTools({
  sessionId,
  accessToken,
}: {
  sessionId: string;
  accessToken: string;
}): Promise<ToolSet> {
  const cached = toolCache.get(sessionId);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < TOOL_CACHE_TTL_MS) {
    return cached.tools;
  }

  let mcpSessionId = mcpSessionCache.get(sessionId) ?? null;

  if (!mcpSessionId) {
    mcpSessionId = await initializeMcp(accessToken);
    if (mcpSessionId) {
      mcpSessionCache.set(sessionId, mcpSessionId);
    }
  }

  const listResponse = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
    sessionHeaderId: mcpSessionId,
  });
  const activeMcpSessionId = listResponse.sessionHeaderId ?? mcpSessionId;

  if (activeMcpSessionId) {
    mcpSessionCache.set(sessionId, activeMcpSessionId);
  }

  const tools = Object.fromEntries(
    listResponse.result.tools.map((mcpTool) => [
      mcpTool.name,
      tool({
        description: mcpTool.description || `TYPO3 MCP tool: ${mcpTool.name}`,
        inputSchema: jsonSchema(
          (mcpTool.inputSchema as Record<string, unknown>) || {
            type: "object",
            additionalProperties: true,
          },
        ),
        execute: async (input) => {
          const result = await callMcpMethod<McpToolResult>({
            accessToken,
            method: "tools/call",
            params: {
              name: mcpTool.name,
              arguments: input,
            },
            sessionHeaderId: mcpSessionCache.get(sessionId) ?? activeMcpSessionId,
          });

          const operation = classifyTool(mcpTool.name);
          const backendRecordUrl =
            operation === "write" ? buildBackendRecordUrl(result.result) : null;

          return {
            ...result.result,
            _meta: {
              operation,
              backendRecordUrl,
            },
          };
        },
      }),
    ]),
  );

  toolCache.set(sessionId, { fetchedAt: now, tools });
  return tools;
}
