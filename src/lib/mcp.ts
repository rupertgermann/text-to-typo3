import http from "node:http";
import https from "node:https";
import { jsonSchema, tool, type ToolSet } from "ai";
import { getChangeTarget, getMcpOutputMeta, hasUnknownWriteOutcome, unknownWriteResult, type ChangeTarget } from "@/lib/mcp-outcome";
import {
  containsUploadTicket, getMcpRecordContent, getMcpResultData, isRecord, localUploadResult,
  mcpResultForDisclosure, parseJsonObject, redactTypo3PreviewUrls,
} from "@/lib/mcp-result-content";
import { registerTypo3Upload } from "@/lib/typo3-upload";
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

type UploadRegistration = Parameters<typeof registerTypo3Upload>[0];
type UploadScope = Pick<UploadRegistration, "userId" | "conversationId">;

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

class ExpiredMcpSessionError extends McpHttpError {
  constructor() {
    super(404);
  }
}

class McpDispatchStoppedError extends Error {}

class McpRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

// One exchange owns this queue, so cached tools never share recovery state.
export function createMcpExecution(signal?: AbortSignal, uploadScope?: UploadScope) {
  let uncertain = false;
  let pendingUpload = false;
  let queue = Promise.resolve();
  return {
    hasUnknownOutcome: () => uncertain,
    hasPendingUpload: () => pendingUpload,
    wrap: (tools: ToolSet, readToolNames: string[]): ToolSet => Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute || readToolNames.includes(name)) return [name, definition];
        const changeTarget = getChangeTarget(name);
        return [name, {
          ...definition,
          execute: (input, options) => {
            const result = queue.then(async () => {
              if (signal?.aborted) return stoppedWriteResult(changeTarget);
              if (uncertain || pendingUpload) return {
                isError: true,
                content: [{ type: "text", text: uncertain
                  ? "Not executed because an earlier TYPO3 write outcome is unknown."
                  : "Waiting for the local file upload before making further TYPO3 changes." }],
                _meta: { operation: "write", outcome: "blocked", changeTarget },
              };
              const output = await execute(input, {
                ...options,
                experimental_context: uploadScope,
                abortSignal: signal && options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal ?? options.abortSignal,
              });
              uncertain ||= hasUnknownWriteOutcome(output);
              pendingUpload ||= getMcpOutputMeta(output)?.outcome === "pending";
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

function stoppedWriteResult(changeTarget?: ChangeTarget) {
  return {
    isError: true,
    content: [{ type: "text", text: "Not executed because generation was stopped." }],
    _meta: { operation: "write", outcome: "blocked", changeTarget },
  };
}

const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const MCP_SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const MCP_SESSION_CACHE_TTL_MS = 25 * 60 * 1000;
const MCP_REQUEST_TIMEOUT_MS = 5_000;
const MCP_URL_UPLOAD_TIMEOUT_MS = 305_000; // TYPO3 allows 300 seconds for the download itself.
const toolCache = new Map<string, CachedToolSet>();
const mcpSessionCache = new Map<string, CachedMcpSession>();

export function resetMcpCachesForTests(): void {
  toolCache.clear();
  mcpSessionCache.clear();
}

export function getTypo3McpUrl(): string {
  const env = getEnv();
  return env.TYPO3_MCP_URL || `${env.TYPO3_BASE_URL}/mcp`;
}

export function getMcpAuthorization(accessToken: string): Record<string, string> {
  const token = accessToken || (new URL(getTypo3McpUrl()).searchParams.has("token")
    ? "" : getEnv().TYPO3_MCP_ACCESS_TOKEN);
  return token ? { Authorization: `Bearer ${token}` } : {};
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

function readUploadScope(scope: unknown): UploadScope | undefined {
  if (isRecord(scope) && typeof scope.userId === "string" && typeof scope.conversationId === "string") {
    return { userId: scope.userId, conversationId: scope.conversationId };
  }
}

function asUploadUrl(input: unknown): string {
  return isRecord(input) && typeof input.url === "string" ? input.url.trim() : "";
}

function uploadHasSource(input: unknown): boolean {
  return Boolean(asUploadUrl(input)) || (isRecord(input) && typeof input.content === "string" && input.content !== "");
}

function normalizeMcpOutput({
  name, operation, result, input, uploadScope, autoApproved,
}: {
  name: string;
  operation: "read" | "write";
  result: Record<string, unknown>;
  input?: unknown;
  uploadScope?: UploadScope;
  autoApproved?: boolean;
}) {
  const changeTarget = getChangeTarget(name);
  const approval = operation === "write" && autoApproved ? "auto-approved" : undefined;
  const data = getMcpResultData(result);

  if (name === "UploadFile") {
    const hasSource = uploadHasSource(input);
    if (containsUploadTicket(result) || (result.isError !== true && !hasSource)) {
      const { uploadUrl, uploadToken, fileName, targetFolder, validUntil } = data;
      const upload = result.isError !== true && !hasSource && uploadScope &&
        typeof uploadUrl === "string" && typeof uploadToken === "string" &&
        (typeof fileName === "string" || fileName === null) &&
        typeof targetFolder === "string" && typeof validUntil === "string"
        ? registerTypo3Upload({ ...uploadScope, uploadUrl, uploadToken, fileName, targetFolder, validUntil })
        : null;
      return {
        ...localUploadResult(upload ? "pending" : "unavailable"),
        _meta: { operation, changeTarget, approval, outcome: upload ? "pending" : "rejected", ...(upload ? { upload } : {}) },
      };
    }
    if (result.isError !== true && (typeof data.uid !== "number" || !Number.isSafeInteger(data.uid) ||
      data.uid <= 0 || typeof data.fileName !== "string" || !data.fileName)) return unknownWriteResult(changeTarget);
  }

  const { output, recordLinks } = getMcpRecordContent(result, name);
  return {
    ...(isRecord(output) ? output : {}),
    _meta: {
      operation,
      changeTarget,
      approval,
      backendRecordUrl: operation === "write" && changeTarget !== "storage" ? buildBackendRecordUrl(data) : null,
      ...(recordLinks.length ? { recordLinks } : {}),
    },
  };
}

export function normalizeNativeMcpOutput(
  output: unknown,
  name: string,
  operation: "read" | "write",
): unknown {
  const changeTarget = getChangeTarget(name);
  const result = isRecord(output) && !output.error && typeof output.output === "string"
    ? parseJsonObject(output.output)
    : undefined;
  const safeOuter = mcpResultForDisclosure(output, name);
  const source = isRecord(safeOuter) && !containsUploadTicket(output) ? safeOuter : {};
  if (!result) {
    if (operation === "read") return { ...source, _meta: { operation } };
    return {
      ...(typeof source.name === "string" ? { name: source.name } : {}),
      ...unknownWriteResult(changeTarget),
    };
  }

  const { _meta, ...safeResult } = normalizeMcpOutput({ name, operation, result });
  const isError = "isError" in safeResult && safeResult.isError === true;
  return {
    ...source,
    output: JSON.stringify(safeResult),
    isError,
    _meta: { ..._meta, outcome: "outcome" in _meta ? _meta.outcome : isError ? "rejected" : "confirmed" },
  };
}

export function classifyMcpTool(
  toolDefinition: Pick<McpToolDefinition, "name" | "annotations">,
): "read" | "write" {
  return !getChangeTarget(toolDefinition.name) && toolDefinition.annotations?.readOnlyHint === true ? "read" : "write";
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
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(createMcpTimeoutError());
  }, timeoutMs);

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

type McpMethodRequest = {
  accessToken: string;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  protocolVersion?: string | null;
  sessionHeaderId?: string | null;
};

async function callMcpMethod<T>({
  accessToken,
  method,
  params,
  protocolVersion,
  sessionHeaderId,
  timeoutMs = MCP_REQUEST_TIMEOUT_MS,
}: McpMethodRequest): Promise<McpMethodResponse<T>> {
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
        ...getMcpAuthorization(accessToken),
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
    timeoutMs,
  );

  if (response.status < 200 || response.status >= 300) {
    if (sessionHeaderId && response.status === 404 &&
      response.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
      const body = parseJsonObject(response.body);
      if (body?.error === "Session not found or expired" && Object.keys(body).length === 1) {
        throw new ExpiredMcpSessionError();
      }
    }
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

async function callMcpWithSession<T>(
  request: Omit<McpMethodRequest, "protocolVersion" | "sessionHeaderId">,
  session: InitializedMcpSession | null,
  { cacheKey, signal }: { cacheKey?: string; signal?: AbortSignal } = {},
): Promise<McpMethodResponse<T>> {
  async function dispatch(active: InitializedMcpSession | null) {
    if (signal?.aborted) throw new McpDispatchStoppedError();
    try {
      const response = await callMcpMethod<T>({
        ...request,
        protocolVersion: active?.protocolVersion,
        sessionHeaderId: active?.sessionId,
      });
      const sessionId = response.sessionHeaderId ?? active?.sessionId;
      if (cacheKey && sessionId) {
        setCachedMcpSession(cacheKey, {
          sessionId,
          protocolVersion: active?.protocolVersion ?? MCP_SUPPORTED_PROTOCOL_VERSION,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof ExpiredMcpSessionError && cacheKey &&
        getCachedMcpSession(cacheKey)?.sessionId === active?.sessionId) {
        mcpSessionCache.delete(cacheKey);
      }
      throw error;
    }
  }

  try {
    return await dispatch(session);
  } catch (error) {
    if (!(error instanceof ExpiredMcpSessionError)) throw error;
    if (signal?.aborted) throw new McpDispatchStoppedError();

    // The transport returns this error before the tool handler is dispatched.
    const cached = cacheKey ? getCachedMcpSession(cacheKey) : null;
    const refreshed = cached ?? await initializeMcp(request.accessToken).catch(() => null);
    if (signal?.aborted) throw new McpDispatchStoppedError();
    if (!refreshed?.sessionId) throw error;
    return dispatch(refreshed);
  }
}

export async function testMcpConnection(accessToken: string): Promise<number> {
  const mcpSession = await initializeMcp(accessToken);
  const listResponse = await callMcpWithSession<McpToolListResult>({
    accessToken,
    method: "tools/list",
  }, mcpSession);

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

  const listResponse = await callMcpWithSession<McpToolListResult>({
    accessToken,
    method: "tools/list",
  }, mcpSession, { cacheKey: sessionId });
  const activeMcpSessionId = getCachedMcpSession(sessionId)?.sessionId;

  const tools = Object.fromEntries(
    listResponse.result.tools.map((mcpTool) => {
      const { name } = mcpTool;
      const operation = classifyMcpTool(mcpTool);
      const changeTarget = getChangeTarget(name);

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
          toModelOutput: ({ output }) => ({ type: "json", value: mcpResultForDisclosure(output, name) }),
          execute: async (input, { abortSignal, experimental_context: uploadScope }) => {
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

            if (operation === "write" && abortSignal?.aborted) return stoppedWriteResult(changeTarget);

            let result: McpMethodResponse<unknown>;
            try {
              result = await callMcpWithSession<unknown>({
                accessToken,
                method: "tools/call",
                timeoutMs: name === "UploadFile" && asUploadUrl(input) ? MCP_URL_UPLOAD_TIMEOUT_MS : undefined,
                params: {
                  name: mcpTool.name,
                  arguments: input,
                },
              }, executeMcpSession, { cacheKey: sessionId, signal: operation === "write" ? abortSignal : undefined });
              if (!isRecord(result.result)) {
                throw new Error("Invalid MCP tool result");
              }
            } catch (error) {
              if (operation === "read") throw error;
              if (error instanceof McpDispatchStoppedError) return stoppedWriteResult(changeTarget);
              if (error instanceof ExpiredMcpSessionError) return {
                isError: true,
                content: [{ type: "text", text: "TYPO3 rejected the expired session before running the tool. Try again in a new message." }],
                _meta: { operation, outcome: "rejected", changeTarget },
              };
              if (error instanceof McpRpcError && error.code === -32602) {
                return {
                  isError: true,
                  content: [{ type: "text", text: name === "UploadFile" && containsUploadTicket(error.message)
                    ? "TYPO3 rejected the file upload." : redactTypo3PreviewUrls(error.message) }],
                  _meta: { operation, outcome: "rejected", changeTarget },
                };
              }
              return unknownWriteResult(changeTarget);
            }

            return normalizeMcpOutput({
              name,
              operation,
              result: result.result,
              input,
              autoApproved: !requireWriteApproval,
              uploadScope: readUploadScope(uploadScope),
            });
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
  const listResponse = await callMcpWithSession<McpToolListResult>({
    accessToken,
    method: "tools/list",
  }, mcpSession);

  return listResponse.result.tools.reduce<Record<"read" | "write", string[]>>(
    (toolNames, mcpTool) => {
      toolNames[classifyMcpTool(mcpTool)].push(mcpTool.name);
      return toolNames;
    },
    { read: [], write: [] },
  );
}
