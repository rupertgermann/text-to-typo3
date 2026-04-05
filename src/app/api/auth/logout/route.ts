import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { revokeSessionTokens } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getEnv } from "@/lib/env";

export async function GET() {
  const env = getEnv();

  if (
    env.TYPO3_MCP_ACCESS_TOKEN ||
    (env.TYPO3_MCP_URL && env.TYPO3_MCP_URL.includes("token="))
  ) {
    return NextResponse.redirect(new URL("/", env.APP_URL));
  }

  const session = await getSession();

  if (session.sessionId) {
    await revokeSessionTokens(session.sessionId);

    // Remove session from DB
    await db.delete(sessions).where(eq(sessions.id, session.sessionId));
  }

  // Clear the Iron Session cookie
  session.destroy();

  return NextResponse.redirect(new URL("/api/auth/login", env.APP_URL));
}
