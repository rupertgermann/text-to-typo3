import { ClientRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import {
  getMcpTools,
  createMcpExecution,
  listMcpToolNamesByOperation,
  resetMcpCachesForTests,
} from "@/lib/mcp";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { stubTokenAuthEnv } from "@/test/auth";

const annotatedTools = [
  {
    name: "AnnotatedRead",
    description: "Read-only test tool.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
  {
    name: "AnnotatedWrite",
    description: "Write-capable test tool.",
    annotations: { readOnlyHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
  {
    name: "UnannotatedDangerous",
    description: "Tool without annotations should fail safe.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
  },
];

describe("MCP tool annotation classification", () => {
  let fakeMcp: FakeMcpServer | null = null;

  afterEach(async () => {
    await fakeMcp?.close();
    fakeMcp = null;
    resetMcpCachesForTests();
    vi.unstubAllEnvs();
  });

  it("classifies tools from readOnlyHint and treats missing annotations as writes", async () => {
    fakeMcp = await startFakeMcpServer({ tools: annotatedTools });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await expect(
      listMcpToolNamesByOperation({ accessToken: "test-mcp-token" }),
    ).resolves.toEqual({
      read: ["AnnotatedRead"],
      write: ["AnnotatedWrite", "UnannotatedDangerous"],
    });
  });

  it("uses annotation classification for approval gating and tool result metadata", async () => {
    fakeMcp = await startFakeMcpServer({ tools: annotatedTools });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    const tools = await getMcpTools({
      sessionId: "conversation-annotation-classification",
      accessToken: "test-mcp-token",
      requireWriteApproval: true,
    });
    const readResult = await tools.AnnotatedRead.execute?.(
      {},
      { messages: [], toolCallId: "read" },
    );
    const writeResult = await tools.AnnotatedWrite.execute?.(
      {},
      { messages: [], toolCallId: "write" },
    );
    const unannotatedResult = await tools.UnannotatedDangerous.execute?.(
      {},
      { messages: [], toolCallId: "missing" },
    );

    expect(tools.AnnotatedRead.needsApproval).toBe(false);
    expect(tools.AnnotatedWrite.needsApproval).toBe(true);
    expect(tools.UnannotatedDangerous.needsApproval).toBe(true);
    expect(readResult).toMatchObject({ _meta: { operation: "read" } });
    expect(writeResult).toMatchObject({ _meta: { operation: "write" } });
    expect(unannotatedResult).toMatchObject({ _meta: { operation: "write" } });
  });
});

describe("MCP uncertain write execution", () => {
  let fakeMcp: FakeMcpServer | null = null;
  afterEach(async () => {
    await fakeMcp?.close();
    resetMcpCachesForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("settles truncated HTTPS writes as unknown and blocks queued writes", async () => {
    fakeMcp = await startFakeMcpServer({ https: true, truncateToolResponses: true });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const execution = createMcpExecution();
    const tools = await getMcpTools({ sessionId: "tls-write", accessToken: "", execution });
    const startedAt = Date.now();
    const results = await Promise.all(["first", "queued"].map((toolCallId) =>
      tools.WriteTable.execute?.({ action: "create", table: "pages" }, { messages: [], toolCallId }),
    ));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(results).toMatchObject([
      { isError: true, _meta: { operation: "write", outcome: "unknown" } },
      { isError: true, _meta: { operation: "write", outcome: "blocked" } },
    ]);
    expect(fakeMcp.toolCalls).toHaveLength(1);
    expect(execution.hasUnknownOutcome()).toBe(true);
  }, 6_500);

  it("rejects truncated HTTPS reads without an unknown write outcome", async () => {
    fakeMcp = await startFakeMcpServer({ https: true, truncateToolResponses: true });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const execution = createMcpExecution();
    const tools = await getMcpTools({ sessionId: "tls-read", accessToken: "", execution });
    await expect(tools.GetPageTree.execute?.({ startPage: 0 }, { messages: [], toolCallId: "read" }))
      .rejects.toThrow();
    expect(fakeMcp.toolCalls).toHaveLength(1);
    expect(execution.hasUnknownOutcome()).toBe(false);
  }, 6_500);

  it("returns healthy HTTPS read and write results", async () => {
    fakeMcp = await startFakeMcpServer({ https: true });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const tools = await getMcpTools({ sessionId: "tls-healthy", accessToken: "" });
    await expect(tools.GetPageTree.execute?.({ startPage: 0 }, { messages: [], toolCallId: "read" }))
      .resolves.toMatchObject({ _meta: { operation: "read" } });
    await expect(tools.WriteTable.execute?.({ action: "create", table: "pages" }, { messages: [], toolCallId: "write" }))
      .resolves.toMatchObject({ uid: 123, _meta: { operation: "write" } });
    expect(fakeMcp.toolCalls).toHaveLength(2);
  });

  it.each([false, true])("times out stalled HTTPS with request.destroy disabled=%s and keeps healthy requests working", async (disableDestroy) => {
    fakeMcp = await startFakeMcpServer({ https: true, hangMethods: ["tools/call"] });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const tools = await getMcpTools({ sessionId: "tls-timeout", accessToken: "" });
    if (disableDestroy) vi.spyOn(ClientRequest.prototype, "destroy").mockImplementation(function (this: ClientRequest) {
      return this;
    });
    await expect(tools.GetPageTree.execute?.({ startPage: 0 }, { messages: [], toolCallId: "read" }))
      .rejects.toThrow("MCP request timed out");
    expect(fakeMcp.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
    resetMcpCachesForTests();
    await expect(listMcpToolNamesByOperation({ accessToken: "" })).resolves.toMatchObject({
      read: expect.arrayContaining(["GetPageTree"]),
      write: expect.arrayContaining(["WriteTable"]),
    });
  }, 6_500);

  it("does not dispatch a write stopped while its MCP session refreshes", async () => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const controller = new AbortController();
    const tools = await getMcpTools({ sessionId: "expired", accessToken: "", execution: createMcpExecution(controller.signal) });
    resetMcpCachesForTests();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (String(init?.body).includes('"initialize"')) {
        entered.resolve();
        await resume.promise;
      }
      return response;
    });
    const writing = tools.WriteTable.execute?.({ action: "create", table: "pages" }, { messages: [], toolCallId: "stopped" });
    await entered.promise;
    controller.abort();
    resume.resolve();
    expect(await writing).toMatchObject({ isError: true, _meta: { operation: "write", outcome: "blocked" } });
    expect(fakeMcp.toolCalls).toHaveLength(0);
  });

  it.each(["lost response", "malformed result"])("serializes writes after %s and isolates the next exchange", async (failure) => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const realFetch = globalThis.fetch;
    let loseResponse = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (String(init?.body).includes('"name":"WriteTable"') && loseResponse) {
        await response.text();
        if (failure === "malformed result") return Response.json({ jsonrpc: "2.0", id: "invalid", result: null });
        throw new TypeError("Response lost after commit");
      }
      return response;
    });
    const execution = createMcpExecution();
    const tools = await getMcpTools({ sessionId: "parallel", accessToken: "", execution });
    const results = await Promise.all(["one", "two"].map((toolCallId) => tools.WriteTable.execute?.({ action: "create", table: "pages" }, { messages: [], toolCallId })));
    expect(results).toMatchObject([{ _meta: { outcome: "unknown" } }, { _meta: { outcome: "blocked" } }]);
    expect(fakeMcp.toolCalls).toHaveLength(1);
    expect(execution.hasUnknownOutcome()).toBe(true);
    await tools.GetPageTree.execute?.({ startPage: 0 }, { messages: [], toolCallId: "read" });
    expect(fakeMcp.toolCalls.at(-1)?.name).toBe("GetPageTree");
    loseResponse = false;
    const fresh = await getMcpTools({ sessionId: "parallel", accessToken: "", execution: createMcpExecution() });
    await fresh.WriteTable.execute?.({ action: "create", table: "pages" }, { messages: [], toolCallId: "new-turn" });
    expect(fakeMcp.toolCalls.filter((call) => call.name === "WriteTable")).toHaveLength(2);
  });
});

describe("MCP transport caches", () => {
  let fakeMcp: FakeMcpServer | null = null;

  afterEach(async () => {
    await fakeMcp?.close();
    fakeMcp = null;
    resetMcpCachesForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refreshes tools and the MCP session when the same session receives a new token", async () => {
    fakeMcp = await startFakeMcpServer({
      sessionIds: ["initial-session", "first-token-session", "refreshed-token-session"],
    });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });

    const firstTools = await getMcpTools({
      sessionId: "conversation-token-refresh",
      accessToken: "first-token",
    });
    await firstTools.GetPageTree.execute?.(
      { startPage: 0 },
      { messages: [], toolCallId: "first" },
    );
    const refreshedTools = await getMcpTools({
      sessionId: "conversation-token-refresh",
      accessToken: "refreshed-token",
    });
    await refreshedTools.GetPageTree.execute?.(
      { startPage: 0 },
      { messages: [], toolCallId: "refreshed" },
    );
    const reusedTools = await getMcpTools({
      sessionId: "conversation-token-refresh",
      accessToken: "refreshed-token",
    });

    const toolCalls = fakeMcp.requests.filter((request) => request.method === "tools/call");
    expect(toolCalls.map((request) => ({
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"],
    }))).toEqual([
      { authorization: "Bearer first-token", sessionId: "first-token-session" },
      { authorization: "Bearer refreshed-token", sessionId: "refreshed-token-session" },
    ]);
    const initializations = fakeMcp.requests.filter((request) => request.method === "initialize");
    expect(initializations.map((request) => request.headers.authorization)).toEqual([
      "Bearer first-token", "Bearer refreshed-token",
    ]);
    expect(initializations.every((request) => !request.headers["mcp-session-id"])).toBe(true);
    expect(fakeMcp.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    expect(reusedTools).toBe(refreshedTools);
  });

  it("reuses cached MCP session ids within the server TTL safety window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await getMcpTools({
      sessionId: "conversation-session-expiry",
      accessToken: "test-mcp-token",
    });
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    await getMcpTools({
      sessionId: "conversation-session-expiry",
      accessToken: "test-mcp-token",
    });

    const initializeRequests = fakeMcp.requests.filter(
      (request) => request.method === "initialize",
    );
    const listRequests = fakeMcp.requests.filter(
      (request) => request.method === "tools/list",
    );

    expect(initializeRequests).toHaveLength(1);
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.headers["mcp-session-id"]).toBe("fake-mcp-session");
    expect(listRequests[1]?.headers["mcp-session-id"]).toBe("fake-mcp-session");
  });

  it("uses a server-rotated session id on subsequent requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fakeMcp = await startFakeMcpServer({
      sessionIds: ["fake-mcp-session-1", "fake-mcp-session-2"],
    });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await getMcpTools({
      sessionId: "conversation-session-rotation",
      accessToken: "test-mcp-token",
    });
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    await getMcpTools({
      sessionId: "conversation-session-rotation",
      accessToken: "test-mcp-token",
    });

    const initializeRequests = fakeMcp.requests.filter(
      (request) => request.method === "initialize",
    );
    const listRequests = fakeMcp.requests.filter(
      (request) => request.method === "tools/list",
    );

    expect(initializeRequests).toHaveLength(1);
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.headers["mcp-session-id"]).toBe("fake-mcp-session-1");
    expect(listRequests[1]?.headers["mcp-session-id"]).toBe("fake-mcp-session-2");
  });

  it("expires cached MCP session ids after the server TTL safety window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    fakeMcp = await startFakeMcpServer({
      sessionIds: ["fake-mcp-session-1", "fake-mcp-session-2"],
    });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await getMcpTools({
      sessionId: "conversation-session-expiry",
      accessToken: "test-mcp-token",
    });
    vi.setSystemTime(new Date("2026-01-01T00:26:00.000Z"));
    await getMcpTools({
      sessionId: "conversation-session-expiry",
      accessToken: "test-mcp-token",
    });

    const initializeRequests = fakeMcp.requests.filter(
      (request) => request.method === "initialize",
    );
    const listRequests = fakeMcp.requests.filter(
      (request) => request.method === "tools/list",
    );

    expect(initializeRequests).toHaveLength(2);
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.headers["mcp-session-id"]).toBe("fake-mcp-session-1");
    expect(listRequests[1]?.headers["mcp-session-id"]).toBe("fake-mcp-session-2");
  });

  it("uses the negotiated protocol version on requests after initialize", async () => {
    fakeMcp = await startFakeMcpServer({
      protocolVersion: "2025-03-26",
    });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await getMcpTools({
      sessionId: "conversation-protocol-version",
      accessToken: "test-mcp-token",
    });

    const initializeRequest = fakeMcp.requests.find(
      (request) => request.method === "initialize",
    );
    const listRequest = fakeMcp.requests.find(
      (request) => request.method === "tools/list",
    );

    expect(initializeRequest?.params).toMatchObject({
      protocolVersion: "2025-06-18",
    });
    expect(listRequest?.headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  it("invalidates the cached tool set when write approval mode changes", async () => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "test-mcp-token" });

    await getMcpTools({
      sessionId: "conversation-approval-mode",
      accessToken: "test-mcp-token",
      requireWriteApproval: true,
    });
    await getMcpTools({
      sessionId: "conversation-approval-mode",
      accessToken: "test-mcp-token",
      requireWriteApproval: false,
    });
    await getMcpTools({
      sessionId: "conversation-approval-mode",
      accessToken: "test-mcp-token",
      requireWriteApproval: true,
    });

    expect(
      fakeMcp.requests.filter((request) => request.method === "tools/list"),
    ).toHaveLength(3);
  });
});
