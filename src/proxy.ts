import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import type { SessionData } from "@/lib/session";
import { getEnv } from "@/lib/env";

const PUBLIC_PATHS = ["/api/auth"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const env = getEnv();

  if (
    env.TYPO3_MCP_ACCESS_TOKEN ||
    (env.TYPO3_MCP_URL && env.TYPO3_MCP_URL.includes("token="))
  ) {
    return NextResponse.next();
  }

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static files
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Check session
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, {
    password:
      process.env.SESSION_SECRET ||
      "complex_password_at_least_32_characters_long_for_dev",
    cookieName: "text-to-typo3-session",
  });

  if (!session.userId || !session.sessionId) {
    return NextResponse.redirect(new URL("/api/auth/login", request.url));
  }

  return response;
}

export const config = {
  // Exclude all Next.js internal dev/runtime assets so HMR can talk directly
  // to the dev server without going through auth proxy logic first.
  matcher: ["/((?!_next|favicon.ico).*)"],
};
