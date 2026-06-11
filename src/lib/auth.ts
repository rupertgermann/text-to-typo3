import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users, type User } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { getSession, type SessionData } from "@/lib/session";
import type { IronSession } from "iron-session";

const LOCAL_TOKEN_USER_ID = "local-token-user";

function isTokenAuthMode() {
  const env = getEnv();
  return Boolean(
    env.TYPO3_MCP_ACCESS_TOKEN ||
      (env.TYPO3_MCP_URL && env.TYPO3_MCP_URL.includes("token=")),
  );
}

async function ensureLocalTokenUser(): Promise<User> {
  const env = getEnv();
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, LOCAL_TOKEN_USER_ID),
  });

  if (existingUser) {
    if (existingUser.display_name !== env.TYPO3_LOCAL_USER_NAME) {
      await db
        .update(users)
        .set({ display_name: env.TYPO3_LOCAL_USER_NAME })
        .where(eq(users.id, LOCAL_TOKEN_USER_ID));

      return {
        ...existingUser,
        display_name: env.TYPO3_LOCAL_USER_NAME,
      };
    }

    return existingUser;
  }

  const [createdUser] = await db
    .insert(users)
    .values({
      id: LOCAL_TOKEN_USER_ID,
      typo3_uid: LOCAL_TOKEN_USER_ID,
      display_name: env.TYPO3_LOCAL_USER_NAME,
    })
    .returning();

  return createdUser!;
}

function createLocalTokenSession(): IronSession<SessionData> {
  return {
    sessionId: `token:${LOCAL_TOKEN_USER_ID}`,
    userId: LOCAL_TOKEN_USER_ID,
  } as IronSession<SessionData>;
}

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

export interface AuthenticatedUserContext {
  accessToken: string;
  session: IronSession<SessionData>;
  user: User;
}

/**
 * Validates the cookie-backed session against the database and ensures the
 * TYPO3 OAuth access token is still usable.
 */
export async function getAuthenticatedUser():
  Promise<AuthenticatedUserContext | null> {
  if (isTokenAuthMode()) {
    const env = getEnv();
    const user = await ensureLocalTokenUser();

    return {
      accessToken: env.TYPO3_MCP_ACCESS_TOKEN,
      session: createLocalTokenSession(),
      user,
    };
  }

  let session: IronSession<SessionData>;

  try {
    session = await getSession();
  } catch {
    return null;
  }

  if (!session.userId || !session.sessionId) {
    return null;
  }

  const dbSession = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.id, session.sessionId),
      eq(sessions.user_id, session.userId),
    ),
  });

  if (!dbSession) {
    return null;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  if (!user) {
    return null;
  }

  const accessToken = await getValidAccessToken(session.sessionId);

  if (!accessToken) {
    return null;
  }

  return { accessToken, session, user };
}

async function revokeToken(token: string): Promise<void> {
  if (isTokenAuthMode()) {
    return;
  }

  const env = getEnv();

  await fetch(`${env.TYPO3_BASE_URL}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: env.TYPO3_OAUTH_CLIENT_ID,
      client_secret: env.TYPO3_OAUTH_CLIENT_SECRET,
    }),
  });
}

/**
 * Best-effort TYPO3 token revocation used during logout. Failures should not
 * block local session cleanup.
 */
export async function revokeSessionTokens(sessionId: string): Promise<void> {
  if (isTokenAuthMode()) {
    return;
  }

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  if (!session) {
    return;
  }

  const tokens: string[] = [];

  try {
    const accessToken = await getValidAccessToken(sessionId);
    if (accessToken) {
      tokens.push(accessToken);
    }
  } catch {
    // Ignore refresh/retrieval failures and still attempt to revoke what we have.
  }

  if (session.refresh_token) {
    tokens.push(decrypt(session.refresh_token));
  }

  await Promise.allSettled(tokens.map((token) => revokeToken(token)));
}
