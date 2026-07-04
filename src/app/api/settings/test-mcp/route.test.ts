import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { setupTestDatabase, type TestDatabase } from "@/test/database";
import { stubTokenAuthEnv } from "@/test/auth";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";

describe("MCP connection test route", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeMcp: FakeMcpServer | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
  });

  afterEach(async () => {
    await fakeMcp?.close();
    fakeMcp = null;
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("requires authentication", async () => {
    vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
    vi.stubEnv("TYPO3_MCP_URL", "");
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "");

    const response = await POST();

    expect(response.status).toBe(401);
  });

  it("reports the MCP tool count on success without leaking the token", async () => {
    fakeMcp = await startFakeMcpServer();
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "secret-token" });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, toolCount: 9 });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  it("categorizes bad URLs, auth failures, and unreachable MCP servers", async () => {
    stubTokenAuthEnv({ mcpUrl: "not a url" });
    const badUrlResponse = await POST();
    const badUrlBody = await badUrlResponse.json();

    fakeMcp = await startFakeMcpServer({ statusByMethod: { "tools/list": 401 } });
    stubTokenAuthEnv({ mcpUrl: fakeMcp.url, mcpToken: "secret-token" });
    const authResponse = await POST();
    const authBody = await authResponse.json();
    await fakeMcp.close();
    fakeMcp = null;

    stubTokenAuthEnv({ mcpUrl: "http://127.0.0.1:9" });
    const unreachableResponse = await POST();
    const unreachableBody = await unreachableResponse.json();

    expect(badUrlBody).toMatchObject({ ok: false, error: { code: "bad_url" } });
    expect(authBody).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect(unreachableBody).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
    expect(JSON.stringify(authBody)).not.toContain("secret-token");
  });
});
