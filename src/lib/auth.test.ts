import { deferred } from "@/test/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getAuthenticatedUser, getValidAccessToken } from "@/lib/auth";
import { withAuth } from "@/lib/api-route";
import { decrypt, encrypt } from "@/lib/crypto";
import { sessions, users } from "@/lib/db/schema";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { LOCAL_TOKEN_USER_ID, seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ userId: "local-token-user", sessionId: "rotating-session" }),
}));

describe("authentication concurrency", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = setupTestDatabase();
    stubTokenAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    database.cleanup();
  });

  async function seedExpiredSession(id = "rotating-session") {
    await db.insert(sessions).values({
      id,
      user_id: LOCAL_TOKEN_USER_ID,
      access_token: encrypt("expired-access"),
      refresh_token: encrypt(`refresh-${id}`),
      expires_at: 1,
    });
  }

  it("authenticates concurrent requests with one rotating refresh and reuses the persisted token", async () => {
    await seedLocalTokenUser();
    await seedExpiredSession();
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "");
    const usedTokens = new Set<string>();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const token = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      if (usedTokens.has(token)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      usedTokens.add(token);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = withAuth(async (_request, auth) => Response.json({ token: auth.accessToken }));
    const request = new NextRequest("http://localhost/api/protected");

    const responses = await Promise.all([handler(request), handler(request), handler(request)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { token: "fresh-access" }, { token: "fresh-access" }, { token: "fresh-access" },
    ]);
    expect(await getValidAccessToken("rotating-session")).toBe("fresh-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await db.query.sessions.findFirst({ where: eq(sessions.id, "rotating-session") });
    expect(stored && decrypt(stored.refresh_token!)).toBe("rotated-refresh");

    await db.update(sessions).set({ expires_at: 1 }).where(eq(sessions.id, "rotating-session"));
    expect(await getValidAccessToken("rotating-session")).toBe("fresh-access");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usedTokens).toEqual(new Set(["refresh-rotating-session", "rotated-refresh"]));
  });

  it.each(["invalid_grant", "network"])("releases the shared refresh after %s failure", async (failure) => {
    await seedLocalTokenUser();
    await seedExpiredSession();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (failure === "network") throw new TypeError("Failed to fetch");
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.allSettled([
      getValidAccessToken("rotating-session"), getValidAccessToken("rotating-session"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (failure === "invalid_grant") {
      expect(results).toEqual([{ status: "fulfilled", value: null }, { status: "fulfilled", value: null }]);
    } else {
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    }
    fetchMock.mockResolvedValue(Response.json({ access_token: "retried-access", expires_in: 3600 }));
    expect(await getValidAccessToken("rotating-session")).toBe("retried-access");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes independent sessions without waiting for another session", async () => {
    await seedLocalTokenUser();
    await seedExpiredSession("first");
    await seedExpiredSession("second");
    const firstResponse = deferred<Response>();
    const firstEntered = deferred<void>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      if (new URLSearchParams(String(init?.body)).get("refresh_token") === "refresh-first") {
        firstEntered.resolve();
        return firstResponse.promise;
      }
      return Response.json({ access_token: "second-access", expires_in: 3600 });
    }));
    const first = getValidAccessToken("first");
    await firstEntered.promise;
    try {
      expect(await getValidAccessToken("second")).toBe("second-access");
    } finally {
      firstResponse.resolve(Response.json({ access_token: "first-access", expires_in: 3600 }));
      expect(await first).toBe("first-access");
    }
  });

  it.each(["headers", "body"])("aborts stalled refresh %s and releases same-session waiters for retry", async (stage) => {
    await seedLocalTokenUser();
    await seedExpiredSession();
    vi.useFakeTimers();
    const stalled = deferred<Response>();
    const entered = deferred<void>();
    let aborted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        stalled.reject(new Error("secret upstream detail"));
      });
      entered.resolve();
      if (stage === "headers") return stalled.promise;
      const response = new Response(null);
      response.json = () => stalled.promise;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = Promise.allSettled([getValidAccessToken("rotating-session"), getValidAccessToken("rotating-session")]);
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(aborted).toBe(true);
      const results = await requests;
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(JSON.stringify(results)).not.toContain("secret upstream detail");
      fetchMock.mockResolvedValue(Response.json({ access_token: "retry", expires_in: 3600 }));
      expect(await getValidAccessToken("rotating-session")).toBe("retry");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      stalled.resolve(Response.json({ access_token: "cleanup" }));
      await requests;
      vi.useRealTimers();
    }
  });

  it("creates one canonical token user for simultaneous first requests and keeps its display name current", async () => {
    const handler = withAuth(async (_request, auth) => Response.json(auth.user));
    const request = new NextRequest("http://localhost/api/protected");
    const responses = await Promise.all([handler(request), handler(request), handler(request)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const stored = await db.select().from(users);
    expect(stored).toHaveLength(1);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([stored[0], stored[0], stored[0]]);

    vi.stubEnv("TYPO3_LOCAL_USER_NAME", "Renamed Editor");
    expect((await getAuthenticatedUser())?.user).toEqual({ ...stored[0], display_name: "Renamed Editor" });
    expect(await db.select().from(users)).toEqual([{ ...stored[0], display_name: "Renamed Editor" }]);
  });
});
