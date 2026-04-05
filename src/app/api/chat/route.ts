import { type NextRequest } from "next/server";
import { eq, and, asc } from "drizzle-orm";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { getSession } from "@/lib/session";
import { getEnv } from "@/lib/env";

const SYSTEM_PROMPT = `You are a helpful assistant for TYPO3 CMS. You help users manage their TYPO3 website by answering questions, providing guidance, and assisting with content management tasks. Be concise, accurate, and helpful. When discussing TYPO3-specific features, refer to the correct TYPO3 version terminology and best practices.`;

export async function POST(request: NextRequest) {
  // Validate session
  const session = await getSession();
  if (!session.userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.userId;

  let body: { messages?: unknown; conversationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { messages: incomingMessages, conversationId } = body;

  if (!conversationId || typeof conversationId !== "string") {
    return Response.json({ error: "conversationId is required" }, { status: 400 });
  }

  if (
    !Array.isArray(incomingMessages) ||
    incomingMessages.length === 0
  ) {
    return Response.json({ error: "messages array is required" }, { status: 400 });
  }

  // Validate the conversation belongs to the authenticated user
  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, conversationId),
      eq(conversations.user_id, userId),
    ),
  });

  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Get the last incoming message (the new user message)
  const lastMessage = incomingMessages[incomingMessages.length - 1] as {
    role: string;
    content: string;
  };

  if (!lastMessage || lastMessage.role !== "user" || !lastMessage.content) {
    return Response.json(
      { error: "Last message must be a user message with content" },
      { status: 400 },
    );
  }

  // Save the incoming user message to the DB
  await db.insert(messages).values({
    conversation_id: conversationId,
    role: "user",
    content:
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content),
  });

  // Load full message history from DB for this conversation
  const dbMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  // Map DB messages to the ModelMessage format for the AI SDK
  const modelMessages = dbMessages.map((msg) => ({
    role: msg.role as "user" | "assistant" | "system",
    content: msg.content,
  }));

  const env = getEnv();
  const openai = createOpenAI({
    apiKey: env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  });

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    onFinish: async (event) => {
      const assistantText = event.text;

      // Save the assistant's full response to the DB
      await db.insert(messages).values({
        conversation_id: conversationId,
        role: "assistant",
        content: assistantText,
      });

      // Update the conversation's updated_at timestamp
      await db
        .update(conversations)
        .set({ updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(conversations.id, conversationId));
    },
  });

  return result.toTextStreamResponse();
}
