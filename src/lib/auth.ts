import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";

/**
 * Retrieves a valid access token for the given session, refreshing it
 * automatically if the current token has expired or is about to expire.
 *
 * Returns null if the session does not exist or the token cannot be refreshed.
 */
export async function getValidAccessToken(
  sessionId: string,
): Promise<string | null> {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  if (!session) return null;

  const now = Math.floor(Date.now() / 1000);

  // If token is still valid (with 60s buffer), return it
  if (session.expires_at && session.expires_at > now + 60) {
    return decrypt(session.access_token);
  }

  // Try to refresh
  if (!session.refresh_token) return null;

  const env = getEnv();
  const refreshResponse = await fetch(`${env.TYPO3_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(session.refresh_token),
      client_id: env.TYPO3_OAUTH_CLIENT_ID,
      client_secret: env.TYPO3_OAUTH_CLIENT_SECRET,
    }),
  });

  if (!refreshResponse.ok) return null;

  const tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  } = await refreshResponse.json();

  const newExpiresAt = now + (tokens.expires_in || 3600);

  await db
    .update(sessions)
    .set({
      access_token: encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token
        ? encrypt(tokens.refresh_token)
        : session.refresh_token,
      expires_at: newExpiresAt,
    })
    .where(eq(sessions.id, sessionId));

  return tokens.access_token;
}
