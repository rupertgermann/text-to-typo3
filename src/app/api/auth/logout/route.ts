import { type NextRequest, NextResponse } from "next/server";
import { revokeSessionTokens } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { withApiRoute } from "@/lib/api-route";
import { getEnv } from "@/lib/env";

export const GET = withApiRoute(async (request: NextRequest) => {
  const env = getEnv();
  const appOrigin = new URL(request.url).origin;

  if (
    env.TYPO3_MCP_ACCESS_TOKEN ||
    (env.TYPO3_MCP_URL && env.TYPO3_MCP_URL.includes("token="))
  ) {
    return NextResponse.redirect(new URL("/", appOrigin));
  }

  const session = await getSession();

  try {
    if (session.sessionId) await revokeSessionTokens(session.sessionId);
  } finally {
    session.destroy();
  }

  return NextResponse.redirect(new URL("/api/auth/login", appOrigin));
});
