import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  conversations,
  messages,
  type Conversation,
  type Message,
} from "@/lib/db/schema";

export type ConversationWithMessages = Conversation & {
  messages: Message[];
};

function buildSearchClause(query: string) {
  const pattern = `%${query.trim()}%`;

  return sql`(
    ${conversations.title} like ${pattern}
    or exists (
      select 1
      from ${messages}
      where ${messages.conversation_id} = ${conversations.id}
        and ${messages.content} like ${pattern}
    )
  )`;
}

export async function listConversationsForUser(
  userId: string,
  query?: string,
): Promise<Conversation[]> {
  const normalizedQuery = query?.trim();

  if (!normalizedQuery) {
    return db.query.conversations.findMany({
      where: eq(conversations.user_id, userId),
      orderBy: [desc(conversations.updated_at)],
    });
  }

  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.user_id, userId), buildSearchClause(normalizedQuery)))
    .orderBy(desc(conversations.updated_at));
}

export async function createConversationForUser(
  userId: string,
  title = "New Conversation",
): Promise<Conversation> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      user_id: userId,
      title,
    })
    .returning();

  return conversation!;
}

export async function getConversationForUser(
  userId: string,
  conversationId: string,
): Promise<Conversation | null> {
  return (
    (await db.query.conversations.findFirst({
      where: and(
        eq(conversations.id, conversationId),
        eq(conversations.user_id, userId),
      ),
    })) ?? null
  );
}

export async function getConversationWithMessagesForUser(
  userId: string,
  conversationId: string,
): Promise<ConversationWithMessages | null> {
  const conversation = await getConversationForUser(userId, conversationId);
  if (!conversation) {
    return null;
  }

  const conversationMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  return { ...conversation, messages: conversationMessages };
}

export async function renameConversationForUser(
  userId: string,
  conversationId: string,
  title: string,
): Promise<Conversation | null> {
  const conversation = await getConversationForUser(userId, conversationId);
  if (!conversation) {
    return null;
  }

  const [updated] = await db
    .update(conversations)
    .set({
      title,
      updated_at: Math.floor(Date.now() / 1000),
    })
    .where(eq(conversations.id, conversationId))
    .returning();

  return updated ?? null;
}

export async function deleteConversationForUser(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const conversation = await getConversationForUser(userId, conversationId);
  if (!conversation) {
    return false;
  }

  await db.delete(conversations).where(eq(conversations.id, conversationId));
  return true;
}
