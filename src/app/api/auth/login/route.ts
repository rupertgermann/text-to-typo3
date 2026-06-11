import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { withApiRoute } from "@/lib/api-route";
import { getEnv } from "@/lib/env";

export const GET = withApiRoute(async () => {
  const env = getEnv();

  if (
    env.TYPO3_MCP_ACCESS_TOKEN ||
    (env.TYPO3_MCP_URL && env.TYPO3_MCP_URL.includes("token="))
  ) {
    return NextResponse.redirect(new URL("/", env.APP_URL));
  }

  // Generate PKCE code verifier (43-128 chars, URL-safe)
  const codeVerifier = randomBytes(32).toString("base64url");

  // Generate code challenge (S256)
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  // Generate state for CSRF protection
  const state = randomBytes(16).toString("hex");

  // Store verifier and state in cookies (short-lived, httpOnly)
  const cookieStore = await cookies();
  cookieStore.set("oauth_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });
  cookieStore.set("oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  // Build TYPO3 OAuth authorize URL
  const authorizeUrl = new URL(`${env.TYPO3_BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", env.TYPO3_OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${env.APP_URL}/api/auth/callback`,
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "mcp");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authorizeUrl.toString());
});
