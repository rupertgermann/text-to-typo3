import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { revokeSessionTokens } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getEnv } from "@/lib/env";

export async function GET() {
  const session = await getSession();

  if (session.sessionId) {
    await revokeSessionTokens(session.sessionId);

    // Remove session from DB
    await db.delete(sessions).where(eq(sessions.id, session.sessionId));
  }

  // Clear the Iron Session cookie
  session.destroy();

  return NextResponse.redirect(new URL("/api/auth/login", getEnv().APP_URL));
}
