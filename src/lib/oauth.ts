import type { getEnv } from "@/lib/env";

type OAuthTokens = { access_token: string; refresh_token?: string; expires_in?: number };
type TokenGrant =
  | { grant_type: "authorization_code"; code: string; redirect_uri: string; code_verifier: string }
  | { grant_type: "refresh_token"; refresh_token: string };

export function getOAuthEndpoint(env: ReturnType<typeof getEnv>, endpoint: "authorize" | "token") {
  const prefix = env.TYPO3_OAUTH_MODE === "mcp" ? "mcp_oauth" : "oauth";
  return `${env.TYPO3_BASE_URL.replace(/\/+$/, "")}/${prefix}/${endpoint}`;
}

export async function requestOAuthTokens(env: ReturnType<typeof getEnv>, grant: TokenGrant) {
  if (env.TYPO3_OAUTH_MODE === "mcp" && !env.TYPO3_OAUTH_CLIENT_ID) return null;

  const body = new URLSearchParams({ ...grant, client_id: env.TYPO3_OAUTH_CLIENT_ID });
  if (env.TYPO3_OAUTH_MODE === "legacy") body.set("client_secret", env.TYPO3_OAUTH_CLIENT_SECRET);

  return oauthRequest(
    getOAuthEndpoint(env, "token"),
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    async (response) => response.ok ? parseOAuthTokens(await response.json()) : null,
  );
}

export function parseOAuthTokens(value: unknown): OAuthTokens {
  if (typeof value !== "object" || value === null || !("access_token" in value)) {
    throw new Error("Invalid OAuth token response");
  }
  const accessToken = value.access_token;
  const refreshToken = "refresh_token" in value ? value.refresh_token : undefined;
  const expiresIn = "expires_in" in value ? value.expires_in : undefined;
  if (typeof accessToken !== "string" || !accessToken ||
      (refreshToken !== undefined && (typeof refreshToken !== "string" || !refreshToken)) ||
      (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0))) {
    throw new Error("Invalid OAuth token response");
  }
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
}

/** The deadline covers headers and body consumption, and cancels upstream I/O. */
export async function oauthRequest<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } catch {
    throw new Error("OAuth request failed");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
