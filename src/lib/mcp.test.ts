import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMcpTools,
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

describe("MCP transport caches", () => {
  let fakeMcp: FakeMcpServer | null = null;

  afterEach(async () => {
    await fakeMcp?.close();
    fakeMcp = null;
    resetMcpCachesForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
