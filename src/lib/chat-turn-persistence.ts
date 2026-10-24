import { and, asc, eq, inArray } from "drizzle-orm";
import type { LanguageModel, UIMessage } from "ai";
import { generateText, isToolUIPart } from "ai";
import { db } from "@/lib/db";
import { conversations, messages, type Conversation } from "@/lib/db/schema";
import {
  extractMessageText,
  serializeMessageParts,
} from "@/lib/chat-message-parts";
import type { ChatTurnResolution } from "@/lib/chat-turn-resolution";

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
  assistantMessageId,
  assistantText,
  historyChange = null,
  continuationAssistantMessageId,
  conversation,
  responseParts,
  titleGenerator,
  tokenUsage,
  userText,
}: {
  assistantMessageId: string;
  assistantText: string;
  historyChange?: ChatTurnResolution["historyChange"];
  continuationAssistantMessageId: string | null;
  conversation: Conversation;
  responseParts: UIMessage["parts"];
  titleGenerator?: TitleGenerator;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null };
  userText: string;
}): Promise<{ titleGeneration: Promise<void> | null }> {
  if (
    assistantText.trim() ||
    responseParts.some(isToolUIPart)
  ) {
    const assistantMessageValues = {
      content: assistantText,
      tool_calls: serializeMessageParts(responseParts),
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
    };

    db.transaction((tx) => {
      if (historyChange) {
        const latestMessage = tx
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversation_id, conversation.id))
          .orderBy(asc(messages.created_at))
          .all()
          .at(-1);
        const expectedLastId =
          historyChange.removeMessageIds.at(-1) ?? historyChange.userMessage?.id;
        if (latestMessage?.id !== expectedLastId) {
          throw new Error(
            "Conversation changed while generating the replacement. Retry the turn.",
          );
        }
        if (historyChange.removeMessageIds.length > 0) {
          const removed = tx
            .delete(messages)
            .where(
              and(
                eq(messages.conversation_id, conversation.id),
                inArray(messages.id, historyChange.removeMessageIds),
              ),
            )
            .run();
          if (removed.changes !== historyChange.removeMessageIds.length) {
            throw new Error(
              "Conversation changed while generating the replacement. Retry the turn.",
            );
          }
        }
        if (historyChange.userMessage) {
          tx.update(messages)
            .set({
              content: extractMessageText(historyChange.userMessage.parts),
              tool_calls: serializeMessageParts(historyChange.userMessage.parts),
            })
            .where(
              and(
                eq(messages.id, historyChange.userMessage.id),
                eq(messages.conversation_id, conversation.id),
              ),
            )
            .run();
        }
      }
      if (continuationAssistantMessageId) {
        tx.update(messages)
          .set(assistantMessageValues)
          .where(
            and(
              eq(messages.id, continuationAssistantMessageId),
              eq(messages.conversation_id, conversation.id),
            ),
          )
          .run();
      } else {
        tx.insert(messages)
          .values({
            id: assistantMessageId,
            conversation_id: conversation.id,
            role: "assistant",
            ...assistantMessageValues,
          })
          .run();
      }
    });
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
  historyChange,
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
  historyChange?: ChatTurnResolution["historyChange"];
  titleGenerator?: TitleGenerator;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null };
  userText: string;
}): Promise<{ titleGeneration: Promise<void> | null }> {
  return persistChatTurn({
    assistantMessageId: responseMessage.id,
    historyChange,
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
