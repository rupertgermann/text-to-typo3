import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { stubTokenAuthEnv } from "@/test/auth";
import { beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { seedLocalTokenUser } from "@/test/auth";
import { sessions } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getValidAccessToken } from "@/lib/auth";
import { withAuth } from "@/lib/api-route";
import { deferred } from "@/test/deferred";
describe("auth logout route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects token-mode logout back to the current app origin", async () => {
    stubTokenAuthEnv();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3002");

    const response = await GET(
      new NextRequest("http://localhost:3001/api/auth/logout"),
    );

    expect(response.headers.get("location")).toBe("http://localhost:3001/");
  });
});


const destroy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ getSession: async () => ({ sessionId: "logout", userId: "local-token-user", destroy }) }));

describe("OAuth logout", () => {
  let database: TestDatabase;
  beforeEach(async () => {
    database = setupTestDatabase();
    stubTokenAuthEnv({ mcpToken: "" });
    destroy.mockClear();
    await seedLocalTokenUser();
    await db.insert(sessions).values({ id: "logout", user_id: "local-token-user", access_token: encrypt("old-access"), refresh_token: encrypt("old-refresh"), expires_at: 1 });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); database.cleanup(); });
  const logout = () => GET(new NextRequest("http://localhost/api/auth/logout"));

  it("revokes stored tokens without starting a refresh", async () => {
    const revoked: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/oauth/token")) return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
      revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return new Response(null);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await logout()).status).toBe(307);
    expect(revoked.sort()).toEqual(["old-access", "old-refresh"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await db.select().from(sessions)).toEqual([]);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("waits for pending rotation, denies new authentication, and revokes the latest pair", async () => {
    const entered = deferred<void>();
    const rotated = deferred<Response>();
    const revoked: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/oauth/token")) { entered.resolve(); return rotated.promise; }
      revoked.push(new URLSearchParams(String(init?.body)).get("token")!);
      return new Response(null);
    }));
    const handler = withAuth(async () => Response.json({ authorized: true }));
    const authenticating = handler(new NextRequest("http://localhost/api/protected"));
    await entered.promise;
    const refreshing = getValidAccessToken("logout");
    const first = logout();
    const second = logout();
    await Promise.resolve();
    expect(await getValidAccessToken("logout")).toBeNull();
    rotated.resolve(Response.json({ access_token: "new-access", refresh_token: "new-refresh" }));
    expect(await refreshing).toBeNull();
    expect((await authenticating).status).toBe(401);
    await Promise.all([first, second]);
    expect(revoked.sort()).toEqual(["new-access", "new-refresh"]);
    expect(await getValidAccessToken("logout")).toBeNull();
    expect(await db.select().from(sessions)).toEqual([]);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "http", "decrypt", "headers", "body"])("cleans local sessions after %s revocation failure", async (failure) => {
    vi.useFakeTimers();
    if (failure === "decrypt") await db.update(sessions).set({ access_token: "broken" }).where(eq(sessions.id, "logout"));
    const signals: AbortSignal[] = [];
    const entered = deferred<void>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      entered.resolve();
      if (failure === "network") throw new Error("secret");
      if (failure === "headers" || failure === "body") {
        const stalled = new Promise<never>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("secret"))));
        if (failure === "headers") return stalled;
        const response = new Response(null);
        response.arrayBuffer = () => stalled;
        return response;
      }
      return new Response(null, { status: failure === "http" ? 500 : 200 });
    }));
    const result = logout();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await result).headers.get("location")).toBe("http://localhost/api/auth/login");
    expect(await db.select().from(sessions)).toEqual([]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

});
