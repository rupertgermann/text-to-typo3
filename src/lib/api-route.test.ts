import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { withAuth } from "@/lib/api-route";
import { setupTestDatabase, type TestDatabase } from "@/test/database";
import {
  LOCAL_TOKEN_USER_ID,
  seedLocalTokenUser,
  stubTokenAuthEnv,
} from "@/test/auth";

describe("withAuth", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("returns the shared unauthorized error when there is no authenticated user", async () => {
    vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
    vi.stubEnv("TYPO3_MCP_URL", "");
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "");

    const handler = withAuth(async () => Response.json({ ok: true }));
    const response = await handler(
      new NextRequest("http://localhost/api/protected"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  it("injects the authenticated user context into the handler", async () => {
    stubTokenAuthEnv();
    await seedLocalTokenUser();

    const handler = withAuth(async (_request, auth) =>
      Response.json({
        accessToken: auth.accessToken,
        sessionId: auth.session.sessionId,
        userId: auth.user.id,
      }),
    );
    const response = await handler(
      new NextRequest("http://localhost/api/protected"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accessToken: "test-mcp-token",
      sessionId: `token:${LOCAL_TOKEN_USER_ID}`,
      userId: LOCAL_TOKEN_USER_ID,
    });
  });
});
