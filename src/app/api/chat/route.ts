import { type NextRequest } from "next/server";
import { eq, and, asc, inArray } from "drizzle-orm";
import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getMcpTools } from "@/lib/mcp";
import { getResolvedUserSettings } from "@/lib/user-settings";
import {
  deserializeMessageParts,
  extractMessageText,
  hasFileParts,
  serializeMessageParts,
} from "@/lib/chat-message-parts";

const SYSTEM_PROMPT = `You are a helpful assistant for TYPO3 CMS. You help users manage their TYPO3 website by answering questions, providing guidance, and assisting with content management tasks. Be concise, accurate, and helpful. When discussing TYPO3-specific features, refer to the correct TYPO3 version terminology and best practices. Use TYPO3 MCP tools when you need live site data or need to modify TYPO3 content. Default writes to TYPO3 workspaces, and ask for confirmation before broad changes that affect many records.`;

function getConversationTitle(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

export async function POST(request: NextRequest) {
  // Validate session
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = auth.user.id;

  let body: { messages?: unknown; conversationId?: unknown; messageId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { messages: incomingMessages, conversationId } = body;
  const messageId =
    typeof (body as { messageId?: unknown }).messageId === "string"
      ? (body as { messageId: string }).messageId
      : undefined;

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
  const userText = lastMessage ? extractMessageText(lastMessage.parts) : "";

  if (
    !lastMessage ||
    lastMessage.role !== "user" ||
    (!userText.trim() && !hasFileParts(lastMessage.parts))
  ) {
    return Response.json(
      {
        error:
          "Last message must be a user message with text or file content",
      },
      { status: 400 },
    );
  }

  const persistedParts = serializeMessageParts(lastMessage.parts);

  if (messageId) {
    const existingMessages = await db.query.messages.findMany({
      where: eq(messages.conversation_id, conversationId),
      orderBy: [asc(messages.created_at)],
    });

    const currentMessageIndex = existingMessages.findIndex(
      (message) => message.id === messageId,
    );

    if (currentMessageIndex === -1) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    if (existingMessages[currentMessageIndex]?.role !== "user") {
      return Response.json(
        { error: "Only user messages can be edited" },
        { status: 400 },
      );
    }

    const trailingMessageIds = existingMessages
      .slice(currentMessageIndex + 1)
      .map((message) => message.id);

    if (trailingMessageIds.length > 0) {
      await db
        .delete(messages)
        .where(inArray(messages.id, trailingMessageIds));
    }

    await db
      .update(messages)
      .set({
        content: userText,
        tool_calls: persistedParts,
      })
      .where(eq(messages.id, messageId));
  } else {
    // Save the incoming user message to the DB
    await db.insert(messages).values({
      conversation_id: conversationId,
      role: "user",
      content: userText,
      tool_calls: persistedParts,
    });
  }

  // Load full message history from DB for this conversation
  const dbMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  const originalMessages: UIMessage[] = dbMessages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    parts:
      deserializeMessageParts(msg.tool_calls) ?? [{ type: "text", text: msg.content }],
  }));

  const modelMessages = await convertToModelMessages(
    originalMessages.map((message) => ({
      role: message.role,
      parts: message.parts,
    })),
  );

  const env = getEnv();
  const userSettings = await getResolvedUserSettings(userId);
  const useLmStudio =
    Boolean(userSettings.lmstudioBaseUrl) &&
    Boolean(userSettings.modelId) &&
    userSettings.modelId === userSettings.lmstudioModelId;

  const provider = createOpenAI({
    apiKey: useLmStudio
      ? "lm-studio"
      : userSettings.openAiApiKey || env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: useLmStudio ? userSettings.lmstudioBaseUrl || undefined : undefined,
  });
  const tools = await getMcpTools({
    sessionId: auth.session.sessionId || `token:${auth.user.id}`,
    accessToken: auth.accessToken,
  });

  const result = streamText({
    model: provider(userSettings.modelId || "gpt-4o-mini"),
    system: [SYSTEM_PROMPT, env.TYPO3_MCP_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
    messages: modelMessages,
    tools,
  });

  return result.toUIMessageStreamResponse({
    originalMessages,
    onFinish: async ({ responseMessage }) => {
      const assistantText = extractMessageText(responseMessage.parts);

      if (assistantText.trim() || responseMessage.parts.some((part) => part.type.startsWith("tool-"))) {
        await db.insert(messages).values({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
          tool_calls: serializeMessageParts(responseMessage.parts),
        });
      }

      if (/^new conversation$/i.test(conversation.title) && userText.trim()) {
        await db
          .update(conversations)
          .set({
            title: getConversationTitle(userText),
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(eq(conversations.id, conversationId));
        return;
      }

      await db
        .update(conversations)
        .set({ updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(conversations.id, conversationId));
    },
  });
}
