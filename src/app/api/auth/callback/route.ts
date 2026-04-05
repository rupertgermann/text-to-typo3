import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { getSession } from "@/lib/session";
import { getEnv } from "@/lib/env";

export async function GET(request: NextRequest) {
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
  const tokenResponse = await fetch(`${env.TYPO3_BASE_URL}/oauth/token`, {
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
  });

  if (!tokenResponse.ok) {
    return NextResponse.redirect(
      new URL("/?error=token_exchange_failed", env.APP_URL),
    );
  }

  const tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
  } = await tokenResponse.json();

  // Fetch user info from TYPO3
  const userResponse = await fetch(`${env.TYPO3_BASE_URL}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userResponse.ok) {
    return NextResponse.redirect(
      new URL("/?error=userinfo_failed", env.APP_URL),
    );
  }

  const userInfo: { sub: string | number; name?: string } =
    await userResponse.json();

  // Upsert user in DB
  const typo3Uid = String(userInfo.sub);
  let user = await db.query.users.findFirst({
    where: eq(users.typo3_uid, typo3Uid),
  });

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({
        typo3_uid: typo3Uid,
        display_name: userInfo.name || `User ${typo3Uid}`,
      })
      .returning();
    user = newUser;
  } else {
    // Update display name in case it changed
    await db
      .update(users)
      .set({ display_name: userInfo.name || user.display_name })
      .where(eq(users.id, user.id));
  }

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
}
