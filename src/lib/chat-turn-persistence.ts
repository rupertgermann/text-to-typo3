import { and, eq } from "drizzle-orm";
import type { LanguageModel, UIMessage } from "ai";
import { generateText } from "ai";
import { db } from "@/lib/db";
import { conversations, messages, type Conversation } from "@/lib/db/schema";
import {
  extractMessageText,
  serializeMessageParts,
} from "@/lib/chat-message-parts";

export type TitleGenerator = (input: {
  assistantText: string;
  fallbackTitle: string;
  userText: string;
}) => Promise<string | null>;

export function getConversationTitle(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

export function sanitizeGeneratedTitle(text: string): string | null {
  const title = text
    .split(/\r?\n/)
    .at(0)
    ?.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();

  return title || null;
}

export function createModelTitleGenerator(model: LanguageModel): TitleGenerator {
  return async ({ assistantText, userText }) => {
    const result = await generateText({
      model,
      maxRetries: 0,
      system:
        "Write a concise, single-line conversation title. Return only the title.",
      prompt: [
        `User: ${userText}`,
        `Assistant: ${assistantText}`,
        "Title:",
      ].join("\n"),
    });

    return sanitizeGeneratedTitle(result.text);
  };
}

export async function persistChatTurn({
  assistantText,
  continuationAssistantMessageId,
  conversation,
  responseParts,
  titleGenerator,
  tokenUsage,
  userText,
}: {
  assistantText: string;
  continuationAssistantMessageId: string | null;
  conversation: Conversation;
  responseParts: UIMessage["parts"];
  titleGenerator?: TitleGenerator;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null };
  userText: string;
}): Promise<{ titleGeneration: Promise<void> | null }> {
  if (
    assistantText.trim() ||
    responseParts.some((part) => part.type.startsWith("tool-"))
  ) {
    const assistantMessageValues = {
      content: assistantText,
      tool_calls: serializeMessageParts(responseParts),
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
    };

    if (continuationAssistantMessageId) {
      await db
        .update(messages)
        .set(assistantMessageValues)
        .where(eq(messages.id, continuationAssistantMessageId));
    } else {
      await db.insert(messages).values({
        conversation_id: conversation.id,
        role: "assistant",
        ...assistantMessageValues,
      });
    }
  }

  if (/^new conversation$/i.test(conversation.title) && userText.trim()) {
    const fallbackTitle = getConversationTitle(userText);
    await db
      .update(conversations)
      .set({
        title: fallbackTitle,
        updated_at: Math.floor(Date.now() / 1000),
      })
      .where(eq(conversations.id, conversation.id));

    return {
      titleGeneration: titleGenerator
        ? updateGeneratedConversationTitle({
            assistantText,
            conversationId: conversation.id,
            fallbackTitle,
            titleGenerator,
            userText,
          })
        : null,
    };
  }

  await db
    .update(conversations)
    .set({ updated_at: Math.floor(Date.now() / 1000) })
    .where(eq(conversations.id, conversation.id));

  return { titleGeneration: null };
}

export async function persistResponseMessage({
  continuationAssistantMessageId,
  conversation,
  responseMessage,
  titleGenerator,
  tokenUsage,
  userText,
}: {
  continuationAssistantMessageId: string | null;
  conversation: Conversation;
  responseMessage: UIMessage;
  titleGenerator?: TitleGenerator;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null };
  userText: string;
}): Promise<{ titleGeneration: Promise<void> | null }> {
  return persistChatTurn({
    assistantText: extractMessageText(responseMessage.parts),
    continuationAssistantMessageId,
    conversation,
    responseParts: responseMessage.parts,
    titleGenerator,
    tokenUsage,
    userText,
  });
}

async function updateGeneratedConversationTitle({
  assistantText,
  conversationId,
  fallbackTitle,
  titleGenerator,
  userText,
}: {
  assistantText: string;
  conversationId: string;
  fallbackTitle: string;
  titleGenerator: TitleGenerator;
  userText: string;
}) {
  try {
    const generatedTitle = await titleGenerator({
      assistantText,
      fallbackTitle,
      userText,
    });

    if (!generatedTitle) {
      return;
    }

    await db
      .update(conversations)
      .set({
        title: generatedTitle,
        updated_at: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.title, fallbackTitle),
        ),
      );
  } catch {
    // The first-words fallback is already persisted; titling must never break chat.
  }
}
