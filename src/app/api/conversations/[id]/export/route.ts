import { type NextRequest } from "next/server";
import { notFound, withAuth } from "@/lib/api-route";
import {
  conversationExportFilename,
  conversationToMarkdown,
} from "@/lib/conversation-export";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withAuth<RouteContext>(async (
  _request: NextRequest,
  auth,
  { params },
) => {
  const { id } = await params;

  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, id),
      eq(conversations.user_id, auth.user.id),
    ),
  });

  if (!conversation) {
    return notFound("Conversation not found");
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
});
