import { type NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/auth";

export async function GET() {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userConversations = await db.query.conversations.findMany({
    where: eq(conversations.user_id, auth.user.id),
    orderBy: [desc(conversations.updated_at)],
  });

  return Response.json(userConversations);
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "New Conversation";

  const [conversation] = await db
    .insert(conversations)
    .values({
      user_id: auth.user.id,
      title,
    })
    .returning();

  return Response.json(conversation, { status: 201 });
}
