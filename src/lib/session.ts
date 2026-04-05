import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import type { IronSession } from "iron-session";

export interface SessionData {
  userId?: string;
  sessionId?: string;
}

function getSessionPassword(): string {
  const password = process.env.SESSION_SECRET?.trim();
  if (password) {
    return password;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }

  return "complex_password_at_least_32_characters_long_for_dev";
}

const sessionOptions = {
  password: getSessionPassword(),
  cookieName: "text-to-typo3-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax" as const,
  },
};

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export { getSessionPassword };
