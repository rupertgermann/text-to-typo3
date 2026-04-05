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

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const toolCache = new Map<string, CachedToolSet>();

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

async function callMcpMethod<T>({
  accessToken,
  method,
  params,
}: {
  accessToken: string;
  method: string;
  params?: Record<string, unknown>;
}): Promise<T> {
  const env = getEnv();
  const mcpUrl = env.TYPO3_MCP_URL || `${env.TYPO3_BASE_URL}/mcp`;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as JsonRpcSuccess<T> | JsonRpcError;

  if ("error" in payload) {
    throw new Error(payload.error.message);
  }

  return payload.result;
}

async function initializeMcp(accessToken: string): Promise<void> {
  try {
    await callMcpMethod({
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
  } catch {
    // Some servers accept direct tools/list calls without initialize.
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

  await initializeMcp(accessToken);

  const list = await callMcpMethod<McpToolListResult>({
    accessToken,
    method: "tools/list",
  });

  const tools = Object.fromEntries(
    list.tools.map((mcpTool) => [
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
          });

          const operation = classifyTool(mcpTool.name);
          const backendRecordUrl =
            operation === "write" ? buildBackendRecordUrl(result) : null;

          return {
            ...result,
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
