import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubTokenAuthEnv } from "@/test/auth";
import { GET } from "./route";

const setCookie = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ set: setCookie }) }));

beforeEach(() => {
  stubTokenAuthEnv({ mcpToken: "" });
  vi.stubEnv("TYPO3_OAUTH_MODE", "mcp");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3014");
  setCookie.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

it("redirects to native authorization with a challenge tied to its verifier cookie", async () => {
  vi.stubEnv("TYPO3_OAUTH_CLIENT_ID", "native-client");

  const response = await GET();
  const location = response.headers.get("location");
  if (!location) throw new Error("Missing authorization redirect");
  const authorize = new URL(location);
  const [, verifier] = setCookie.mock.calls.find(([name]) => name === "oauth_code_verifier") ?? [];
  const [, state] = setCookie.mock.calls.find(([name]) => name === "oauth_state") ?? [];

  expect(authorize.origin + authorize.pathname).toBe("https://typo3.example.test/mcp_oauth/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    client_id: "native-client",
    redirect_uri: "http://localhost:3014/api/auth/callback",
    response_type: "code",
    scope: "mcp_access",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
});

it("reports missing native client configuration before setting OAuth cookies", async () => {
  vi.stubEnv("TYPO3_OAUTH_CLIENT_ID", "");

  const response = await GET();

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "oauth_not_configured" } });
  expect(setCookie).not.toHaveBeenCalled();
});
