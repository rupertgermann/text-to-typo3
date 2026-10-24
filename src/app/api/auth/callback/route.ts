import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getSession } from "@/lib/session";
import { withApiRoute } from "@/lib/api-route";
import { getEnv } from "@/lib/env";
import { oauthRequest, parseOAuthTokens } from "@/lib/oauth";

export const GET = withApiRoute(async (request: NextRequest) => {
  const env = getEnv();
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
  const tokens = await oauthRequest(
    `${env.TYPO3_BASE_URL}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${env.APP_URL}/api/auth/callback`,
        client_id: env.TYPO3_OAUTH_CLIENT_ID,
        client_secret: env.TYPO3_OAUTH_CLIENT_SECRET,
        code_verifier: codeVerifier,
      }),
    },
    async (response) => response.ok ? parseOAuthTokens(await response.json()) : null,
  ).catch(() => null);

  if (!tokens) {
    return NextResponse.redirect(
      new URL("/?error=token_exchange_failed", env.APP_URL),
    );
  }

  // Fetch user info from TYPO3
  const userInfo = await oauthRequest(
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

  if (!userInfo) {
    return NextResponse.redirect(
      new URL("/?error=userinfo_failed", env.APP_URL),
    );
  }

  // Upsert user in DB
  const typo3Uid = String(userInfo.sub);
  const [user] = await db
    .insert(users)
    .values({
      typo3_uid: typo3Uid,
      display_name: userInfo.name || `User ${typo3Uid}`,
    })
    .onConflictDoUpdate({
      target: users.typo3_uid,
      set: { display_name: userInfo.name || users.display_name },
    })
    .returning();

  // Store encrypted tokens in sessions table
  const expiresAt =
    Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

  const [dbSession] = await db
    .insert(sessions)
    .values({
      user_id: user.id,
      access_token: encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token
        ? encrypt(tokens.refresh_token)
        : null,
      expires_at: expiresAt,
    })
    .returning();

  // Set Iron Session cookie
  const session = await getSession();
  session.userId = user.id;
  session.sessionId = dbSession.id;
  await session.save();

  return NextResponse.redirect(new URL("/", env.APP_URL));
});
