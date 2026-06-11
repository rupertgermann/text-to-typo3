import { and, asc, eq, inArray } from "drizzle-orm";
import { isToolUIPart, type UIMessage } from "ai";
import { db } from "@/lib/db";
import { conversations, messages, type Conversation } from "@/lib/db/schema";
import {
  extractMessageText,
  hasFileParts,
  serializeMessageParts,
} from "@/lib/chat-message-parts";

export type ChatTurnTrigger = "submit-message" | "regenerate-message";

export class ChatTurnResolutionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "ChatTurnResolutionError";
  }
}

export interface ChatTurnResolution {
  continuationAssistantMessageId: string | null;
  conversation: Conversation;
  userText: string;
}

function hasApprovalResponseParts(message: UIMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parts.some(
      (part) => isToolUIPart(part) && part.state === "approval-responded",
    )
  );
}

export async function resolveChatTurn({
  conversationId,
  messageId,
  trigger,
  uiMessages,
  userId,
}: {
  conversationId: string;
  messageId?: string;
  trigger: ChatTurnTrigger;
  uiMessages: UIMessage[];
  userId: string;
}): Promise<ChatTurnResolution> {
  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, conversationId),
      eq(conversations.user_id, userId),
    ),
  });

  if (!conversation) {
    throw new ChatTurnResolutionError("Conversation not found", 404);
  }

  const lastMessage = uiMessages.at(-1);

  if (trigger === "regenerate-message") {
    const userText = await resolveRegenerationTurn({
      conversationId,
      messageId,
    });

    return {
      continuationAssistantMessageId: null,
      conversation,
      userText,
    };
  }

  if (lastMessage && hasApprovalResponseParts(lastMessage)) {
    const { continuationAssistantMessageId, userText } =
      await resolveApprovalContinuationTurn({
        conversationId,
        lastMessage,
        messageId,
      });

    return {
      continuationAssistantMessageId,
      conversation,
      userText,
    };
  }

  const userText = await resolveSubmitTurn({
    conversationId,
    lastMessage,
    messageId,
  });

  return {
    continuationAssistantMessageId: null,
    conversation,
    userText,
  };
}

async function resolveRegenerationTurn({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId?: string;
}): Promise<string> {
  const existingMessages = await orderedConversationMessages(conversationId);
  const latestAssistantIndex = existingMessages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const targetAssistantIndex = messageId
    ? existingMessages.findIndex((message) => message.id === messageId)
    : latestAssistantIndex;

  if (
    targetAssistantIndex === -1 ||
    targetAssistantIndex !== latestAssistantIndex ||
    targetAssistantIndex !== existingMessages.length - 1 ||
    existingMessages[targetAssistantIndex]?.role !== "assistant"
  ) {
    throw new ChatTurnResolutionError(
      "Only the latest assistant message can be regenerated",
      400,
    );
  }

  const precedingUserMessage = existingMessages
    .slice(0, targetAssistantIndex)
    .findLast((message) => message.role === "user");

  if (!precedingUserMessage) {
    throw new ChatTurnResolutionError(
      "No user message found to regenerate from",
      400,
    );
  }

  await db
    .delete(messages)
    .where(eq(messages.id, existingMessages[targetAssistantIndex].id));

  return precedingUserMessage.content;
}

async function resolveApprovalContinuationTurn({
  conversationId,
  lastMessage,
  messageId,
}: {
  conversationId: string;
  lastMessage: UIMessage;
  messageId?: string;
}): Promise<{ continuationAssistantMessageId: string; userText: string }> {
  const existingMessages = await orderedConversationMessages(conversationId);
  const targetMessageId = messageId ?? lastMessage.id;
  const currentMessageIndex = existingMessages.findIndex(
    (message) => message.id === targetMessageId,
  );

  if (currentMessageIndex === -1) {
    throw new ChatTurnResolutionError("Message not found", 404);
  }

  if (
    currentMessageIndex !== existingMessages.length - 1 ||
    existingMessages[currentMessageIndex]?.role !== "assistant"
  ) {
    throw new ChatTurnResolutionError(
      "Only the latest assistant approval can be continued",
      400,
    );
  }

  const precedingUserMessage = existingMessages
    .slice(0, currentMessageIndex)
    .findLast((message) => message.role === "user");

  if (!precedingUserMessage) {
    throw new ChatTurnResolutionError(
      "No user message found for approval continuation",
      400,
    );
  }

  await db
    .update(messages)
    .set({
      content: extractMessageText(lastMessage.parts),
      tool_calls: serializeMessageParts(lastMessage.parts),
    })
    .where(eq(messages.id, targetMessageId));

  return {
    continuationAssistantMessageId: targetMessageId,
    userText: precedingUserMessage.content,
  };
}

async function resolveSubmitTurn({
  conversationId,
  lastMessage,
  messageId,
}: {
  conversationId: string;
  lastMessage: UIMessage | undefined;
  messageId?: string;
}): Promise<string> {
  const userText = lastMessage ? extractMessageText(lastMessage.parts) : "";

  if (
    !lastMessage ||
    lastMessage.role !== "user" ||
    (!userText.trim() && !hasFileParts(lastMessage.parts))
  ) {
    throw new ChatTurnResolutionError(
      "Last message must be a user message with text or file content",
      400,
    );
  }

  const persistedParts = serializeMessageParts(lastMessage.parts);

  if (messageId) {
    const existingMessages = await orderedConversationMessages(conversationId);
    const currentMessageIndex = existingMessages.findIndex(
      (message) => message.id === messageId,
    );

    if (currentMessageIndex === -1) {
      throw new ChatTurnResolutionError("Message not found", 404);
    }

    if (existingMessages[currentMessageIndex]?.role !== "user") {
      throw new ChatTurnResolutionError("Only user messages can be edited", 400);
    }

    const trailingMessageIds = existingMessages
      .slice(currentMessageIndex + 1)
      .map((message) => message.id);

    if (trailingMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, trailingMessageIds));
    }

    await db
      .update(messages)
      .set({
        content: userText,
        tool_calls: persistedParts,
      })
      .where(eq(messages.id, messageId));

    return userText;
  }

  await db.insert(messages).values({
    conversation_id: conversationId,
    role: "user",
    content: userText,
    tool_calls: persistedParts,
  });

  return userText;
}

function orderedConversationMessages(conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });
}
