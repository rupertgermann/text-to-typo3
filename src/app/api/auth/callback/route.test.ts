import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { stubTokenAuthEnv } from "@/test/auth";
import { users, sessions } from "@/lib/db/schema";
import { createServer } from "node:http";
import { deferred } from "@/test/deferred";
import { getValidAccessToken } from "@/lib/auth";
const saved = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ getSession: async () => ({ save: saved }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => ({ value: name === "oauth_state" ? "state" : "verifier" }),
  delete: vi.fn(),
}) }));
let database: TestDatabase;
beforeEach(() => { database = setupTestDatabase(); stubTokenAuthEnv({ mcpToken: "" }); saved.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); database.cleanup(); });
it("creates a canonical user and independent sessions for concurrent callbacks, preserving omitted names", async () => {
  let name: string | undefined = "Editor";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith("/oauth/token")
      ? Response.json({ access_token: "access", refresh_token: "refresh" })
      : Response.json({ sub: "42", name })));
  const callback = () => GET(new NextRequest("http://localhost/api/auth/callback?code=code&state=state"));
  const results = await Promise.allSettled([callback(), callback()]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
  name = undefined;
  await callback();
  const stored = await db.select().from(users);
  expect(stored).toHaveLength(1);
  expect(stored[0].display_name).toBe("Editor");
  const logins = await db.select().from(sessions);
  expect(logins).toHaveLength(3);
  expect(logins.every(session => session.user_id === stored[0].id)).toBe(true);
  expect(saved).toHaveBeenCalledTimes(3);
});


it("rejects a mismatched state before contacting OAuth", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const response = await GET(new NextRequest("http://localhost/api/auth/callback?code=code&state=wrong"));
  expect(response.headers.get("location")).toContain("error=invalid_state");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("authenticates the short-lived nonrefreshable token accepted by the callback", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith("/oauth/token")
      ? Response.json({ access_token: "short-lived-access", expires_in: 30 })
      : Response.json({ sub: "42", name: "Editor" })));

  const response = await GET(new NextRequest("http://localhost/api/auth/callback?code=code&state=state"));
  const session = await db.query.sessions.findFirst();

  expect(response.status).toBe(307);
  expect(session?.refresh_token).toBeNull();
  expect(session).toBeDefined();
  expect(await getValidAccessToken(session!.id)).toBe("short-lived-access");
});

it.each([
  ["token", "headers"], ["token", "body"],
  ["userinfo", "headers"], ["userinfo", "body"],
])("cancels real OAuth %s I/O stalled at %s and returns a safe redirect", async (endpoint, stage) => {
  const entered = deferred<void>();
  const disconnected = deferred<void>();
  const server = createServer((request, response) => {
    if (!request.url?.endsWith(endpoint)) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ access_token: "secret-access" }));
      return;
    }
    request.socket.once("close", () => disconnected.resolve());
    if (stage === "body") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"secret":');
    }
    entered.resolve();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  vi.stubEnv("TYPO3_BASE_URL", `http://127.0.0.1:${address.port}`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = GET(new NextRequest("http://localhost/api/auth/callback?code=secret-code&state=state"));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_001);
    vi.useRealTimers();
    const response = await result;
    expect(response.headers.get("location")).toContain(endpoint === "token" ? "error=token_exchange_failed" : "error=userinfo_failed");
    expect(response.headers.get("location")).not.toContain("secret");
    await disconnected.promise;
    expect(await db.select().from(sessions)).toEqual([]);
  } finally {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
