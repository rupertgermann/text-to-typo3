type OAuthTokens = { access_token: string; refresh_token?: string; expires_in?: number };

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
