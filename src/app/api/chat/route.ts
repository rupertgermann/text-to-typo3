import { type NextRequest } from "next/server";
import { eq, and, asc } from "drizzle-orm";
import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";

const SYSTEM_PROMPT = `You are a helpful assistant for TYPO3 CMS. You help users manage their TYPO3 website by answering questions, providing guidance, and assisting with content management tasks. Be concise, accurate, and helpful. When discussing TYPO3-specific features, refer to the correct TYPO3 version terminology and best practices.`;

function getTextFromUIMessage(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export async function POST(request: NextRequest) {
  // Validate session
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = auth.user.id;

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

  if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
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
  const uiMessages = incomingMessages as UIMessage[];
  const lastMessage = uiMessages[uiMessages.length - 1];
  const userText = lastMessage ? getTextFromUIMessage(lastMessage) : "";

  if (!lastMessage || lastMessage.role !== "user" || !userText.trim()) {
    return Response.json(
      { error: "Last message must be a user message with text content" },
      { status: 400 },
    );
  }

  // Save the incoming user message to the DB
  await db.insert(messages).values({
    conversation_id: conversationId,
    role: "user",
    content: userText,
  });

  // Load full message history from DB for this conversation
  const dbMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  const originalMessages: UIMessage[] = dbMessages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    parts: [{ type: "text", text: msg.content }],
  }));

  const modelMessages = await convertToModelMessages(
    originalMessages.map((message) => ({
      role: message.role,
      parts: message.parts,
    })),
  );

  const env = getEnv();
  const openai = createOpenAI({
    apiKey: env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  });

  const result = streamText({
    model: openai("gpt-4o-mini"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse({
    originalMessages,
    onFinish: async ({ responseMessage }) => {
      const assistantText = getTextFromUIMessage(responseMessage);

      if (assistantText.trim()) {
        await db.insert(messages).values({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
        });
      }

      await db
        .update(conversations)
        .set({ updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(conversations.id, conversationId));
    },
  });
}
