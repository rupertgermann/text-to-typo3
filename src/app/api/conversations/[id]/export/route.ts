import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  conversationExportFilename,
  conversationToMarkdown,
} from "@/lib/conversation-export";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, id),
      eq(conversations.user_id, auth.user.id),
    ),
  });

  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const conversationMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, id),
    orderBy: [asc(messages.created_at)],
  });

  const markdown = conversationToMarkdown(conversation, conversationMessages);
  const filename = conversationExportFilename(conversation.title);

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
