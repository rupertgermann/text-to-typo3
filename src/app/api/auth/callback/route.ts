import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getSession } from "@/lib/session";
import { apiError, withApiRoute } from "@/lib/api-route";
import { getEnv } from "@/lib/env";
import { oauthRequest, requestOAuthTokens } from "@/lib/oauth";

export const GET = withApiRoute(async (request: NextRequest) => {
  const env = getEnv();
  const native = env.TYPO3_OAUTH_MODE === "mcp";
  if (native && !env.TYPO3_OAUTH_CLIENT_ID) {
    return apiError("oauth_not_configured", "Set TYPO3_OAUTH_CLIENT_ID for TYPO3 MCP OAuth", 503);
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL("/?error=oauth_denied", env.APP_URL));
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/?error=missing_params", env.APP_URL),
    );
  }

  // Verify state matches what we stored
  const cookieStore = await cookies();
  const savedState = cookieStore.get("oauth_state")?.value;
  const codeVerifier = cookieStore.get("oauth_code_verifier")?.value;

  if (state !== savedState || !codeVerifier) {
    return NextResponse.redirect(
      new URL("/?error=invalid_state", env.APP_URL),
    );
  }

  // Clean up OAuth cookies
  cookieStore.delete("oauth_state");
  cookieStore.delete("oauth_code_verifier");

  // Exchange authorization code for tokens
  const tokens = await requestOAuthTokens(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: `${env.APP_URL}/api/auth/callback`,
    code_verifier: codeVerifier,
  }).catch(() => null);

  if (!tokens) {
    return NextResponse.redirect(
      new URL("/?error=token_exchange_failed", env.APP_URL),
    );
  }

  const userInfo = native ? null : await oauthRequest(
    `${env.TYPO3_BASE_URL}/oauth/userinfo`,
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
    async (response) => {
      if (!response.ok) return null;
      const value: unknown = await response.json();
      if (typeof value !== "object" || value === null || !("sub" in value) ||
          !((typeof value.sub === "string" && value.sub) || typeof value.sub === "number")) return null;
      const name = "name" in value ? value.name : undefined;
      if (name !== undefined && typeof name !== "string") return null;
      return { sub: value.sub, name };
    },
  ).catch(() => null);

  if (!native && !userInfo) {
    return NextResponse.redirect(
      new URL("/?error=userinfo_failed", env.APP_URL),
    );
  }

  const session = await getSession();
  const dbSession = db.transaction((tx) => {
    // Native grants supply no verified user identifier, so each grant owns a fresh local principal.
    const typo3Uid = userInfo ? String(userInfo.sub) : `mcp-grant:${randomUUID()}`;
    const insert = tx.insert(users).values({
      typo3_uid: typo3Uid,
      display_name: userInfo ? userInfo.name || `User ${typo3Uid}` : "TYPO3 MCP user",
    });
    const user = userInfo
      ? insert.onConflictDoUpdate({
        target: users.typo3_uid,
        set: { display_name: userInfo.name || users.display_name },
      }).returning().get()
      : insert.returning().get();

    return tx.insert(sessions).values({
      user_id: user.id,
      access_token: encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
    }).returning().get();
  });

  // Set Iron Session cookie
  session.userId = dbSession.user_id;
  session.sessionId = dbSession.id;
  await session.save();

  return NextResponse.redirect(new URL("/", env.APP_URL));
});
