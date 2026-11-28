import { ClientRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import {
  getMcpTools,
  getTypo3McpUrl,
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

describe("TYPO3 14 tool result envelopes", () => {
  it("keeps live links and file receipts while confining preview URLs to UI metadata", async () => {
    const live = "https://www.example.test/team";
    const preview = `${live}?ADMCMD_prev=0123456789abcdef#c12`;
    const envelope = (text: string) => ({ content: [{ type: "text", text }] });
    const toolResults = {
      ReadTable: envelope(JSON.stringify({ records: [{ uid: 12, frontend_url: live, preview_url: preview }] })),
      WriteTable: envelope(JSON.stringify({ table: "pages", uid: 12, frontend_url: live, preview_url: preview })),
      GetPage: envelope(`UID: 12\nURL: ${live}\nPreview URL: ${preview}\n`),
      GetPageTree: envelope(`  └── [12] Team - ${live} (preview with unpublished changes: ${preview})\n`),
      UploadFile: envelope(JSON.stringify({ uid: 22, fileName: "photo.jpg", publicUrl: `${live}/photo.jpg` })),
    };
    const server = await startFakeMcpServer({
      tools: Object.keys(toolResults).map((name) => ({
        name, description: name, inputSchema: { type: "object" },
        annotations: { readOnlyHint: name !== "WriteTable" && name !== "UploadFile" },
      })),
      toolResults,
    });
    stubTokenAuthEnv({ mcpUrl: server.url });
    try {
      const tools = await getMcpTools({ sessionId: "v14-results", accessToken: "test-mcp-token" });
      for (const name of ["ReadTable", "WriteTable", "GetPage", "GetPageTree"]) {
        const tool = tools[name];
        const input = {};
        const toolCallId = name;
        const output = await tool.execute?.(input, { messages: [], toolCallId });
        expect(output).toMatchObject({
          _meta: { recordLinks: expect.arrayContaining([{ kind: "live", url: live }, { kind: "preview", url: preview }]) },
        });
        const model = await tool.toModelOutput?.({ toolCallId, input, output });
        expect(JSON.stringify(model)).toContain(live);
        expect(JSON.stringify(model)).not.toContain("0123456789abcdef");
        expect(JSON.stringify(model)).not.toContain("_meta");
        expect(JSON.stringify(output)).not.toContain("preview_url");
        expect(JSON.stringify(output).match(/0123456789abcdef/g)).toHaveLength(1);
      }
      const upload = await tools.UploadFile.execute?.({ url: "https://source.example.test/photo.jpg" }, { toolCallId: "receipt", messages: [] });
      expect(upload).toMatchObject({ ...toolResults.UploadFile, _meta: { operation: "write", changeTarget: "storage" } });
    } finally {
      await server.close();
      resetMcpCachesForTests();
      vi.unstubAllEnvs();
    }
  });
});

describe("UploadFile execution", () => {
  let server: FakeMcpServer | undefined;

  afterEach(async () => {
    await server?.close();
    resetMcpCachesForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("blocks a workspace write queued behind a local upload handoff", async () => {
    server = await startFakeMcpServer({
      tools: ["UploadFile", "WriteTable"].map((name) => ({
        name, description: name, inputSchema: { type: "object" }, annotations: { readOnlyHint: false },
      })),
      toolResults: { UploadFile: { content: [{ type: "text", text: JSON.stringify({
        uploadUrl: "https://typo3.example.test/mcp_upload",
        uploadToken: "pending-bearer",
        fileName: "photo.jpg",
        targetFolder: "1:/user_upload/",
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      }) }] } },
    });
    stubTokenAuthEnv({ mcpUrl: server.url });
    const execution = createMcpExecution(undefined, { userId: "user", conversationId: "conversation" });
    const tools = await getMcpTools({ sessionId: "upload-queue", accessToken: "", execution });
    const results = await Promise.all([
      tools.UploadFile.execute?.({}, { messages: [], toolCallId: "pending" }),
      tools.WriteTable.execute?.({}, { messages: [], toolCallId: "blocked" }),
    ]);
    expect(results).toMatchObject([
      { _meta: { changeTarget: "storage", outcome: "pending" } },
      { isError: true, _meta: { changeTarget: "workspace", outcome: "blocked" } },
    ]);
    expect(server.toolCalls.map(({ name }) => name)).toEqual(["UploadFile"]);
    expect(execution.hasPendingUpload()).toBe(true);
  });

  it("waits past the default MCP timeout for a URL upload without retrying it", async () => {
    server = await startFakeMcpServer({
      tools: [{ name: "UploadFile", description: "Upload a file", inputSchema: { type: "object" } }],
    });
    stubTokenAuthEnv({ mcpUrl: server.url });
    const tools = await getMcpTools({ sessionId: "remote-upload", accessToken: "" });
    vi.useFakeTimers();
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    vi.stubGlobal("fetch", request);
    const result = tools.UploadFile.execute?.({ url: "https://source.test/photo.jpg" }, { messages: [], toolCallId: "remote" });

    await vi.advanceTimersByTimeAsync(5_001);
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(await result).toMatchObject({ isError: true, _meta: { outcome: "unknown", changeTarget: "storage" } });
    expect(request).toHaveBeenCalledTimes(1);
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

  it("uses the Authorization header for configured tokens and honors an explicit legacy query", async () => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "configured-bearer" });

    expect(getTypo3McpUrl()).toBe(fakeMcp.url);
    await listMcpToolNamesByOperation({ accessToken: "" });
    expect(fakeMcp.requests[0]).toMatchObject({ url: "/", headers: { authorization: "Bearer configured-bearer" } });

    vi.stubEnv("TYPO3_MCP_URL", `${fakeMcp.url}?token=legacy`);
    await listMcpToolNamesByOperation({ accessToken: "" });
    expect(fakeMcp.requests.at(-1)?.url).toBe("/?token=legacy");
    expect(fakeMcp.requests.at(-1)?.headers.authorization).toBeUndefined();
  });

  it.each(["list", "read", "write", "generic 404"])("handles session rejection during %s", async (scenario) => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url });
    const sessionId = "expiring-session";
    const accessToken = "test-mcp-token";
    const tools = await getMcpTools({ sessionId, accessToken });
    const realFetch = globalThis.fetch;
    const method = scenario === "list" ? "tools/list" : "tools/call";
    const attempts: (string | null)[] = [];
    let renewed = false;
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const rpc = String(init?.body);
      if (rpc.includes(`"method":"${method}"`)) {
        attempts.push(new Headers(init?.headers).get("Mcp-Session-Id"));
        if (attempts.length === 1) {
          return Response.json({ error: scenario === "generic 404" ? "Record not found" : "Session not found or expired" }, { status: 404 });
        }
      }
      if (rpc.includes('"method":"initialize"')) renewed = true;
      const response = await realFetch(input, init);
      if (!renewed) return response;
      const headers = new Headers(response.headers);
      headers.set("Mcp-Session-Id", "renewed-session");
      return new Response(response.body, { status: response.status, headers });
    });

    try {
      const options = { messages: [], toolCallId: "session-retry" };
      if (scenario === "list") {
        await expect(getMcpTools({ sessionId, accessToken, requireWriteApproval: false })).resolves.toHaveProperty("WriteTable");
      } else if (scenario === "read") {
        await expect(tools.GetPageTree.execute?.({}, options)).resolves.toMatchObject({ _meta: { operation: "read" } });
      } else if (scenario === "write") {
        await expect(tools.WriteTable.execute?.({ table: "pages" }, options)).resolves.toMatchObject({ uid: 123 });
      } else {
        await expect(tools.WriteTable.execute?.({ table: "pages" }, options)).resolves.toMatchObject({ _meta: { outcome: "unknown" } });
      }
      expect(attempts).toEqual(scenario === "generic 404" ? ["fake-mcp-session"] : ["fake-mcp-session", "renewed-session"]);
      expect(fakeMcp.toolCalls).toHaveLength(scenario === "read" || scenario === "write" ? 1 : 0);
      expect(fakeMcp.requests.filter(({ method }) => method === "initialize")).toHaveLength(scenario === "generic 404" ? 1 : 2);
    } finally {
      mock.mockRestore();
    }
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
