import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMcpTools,
  resetMcpCachesForTests,
} from "@/lib/mcp";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { stubTokenAuthEnv } from "@/test/auth";

describe("MCP transport caches", () => {
  let fakeMcp: FakeMcpServer | null = null;

  afterEach(async () => {
    await fakeMcp?.close();
    fakeMcp = null;
    resetMcpCachesForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("expires cached MCP session ids and reinitializes transparently", async () => {
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

    expect(initializeRequests).toHaveLength(2);
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.headers["mcp-session-id"]).toBe("fake-mcp-session-1");
    expect(listRequests[1]?.headers["mcp-session-id"]).toBe("fake-mcp-session-2");
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
