import { isDeepStrictEqual } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { isToolUIPart, type UIMessage } from "ai";
import { db } from "@/lib/db";
import { listMcpToolNamesByOperation } from "@/lib/mcp";
import { conversations, messages, type Conversation } from "@/lib/db/schema";
import {
  deserializeMessageParts,
  extractMessageText,
  hasFileParts,
  sanitizeMessageParts,
  serializeMessageParts,
} from "@/lib/chat-message-parts";

export type ChatTurnTrigger = "submit-message" | "regenerate-message";

export class ChatTurnResolutionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "ChatTurnResolutionError";
  }
}

export interface ChatTurnResolution {
  continuationAssistantMessageId: string | null;
  claimApproval: (() => void) | null;
  conversation: Conversation;
  userText: string;
  historyChange: {
    removeMessageIds: string[];
    userMessage: UIMessage | null;
  } | null;
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
  accessToken,
}: {
  conversationId: string;
  messageId?: string;
  trigger: ChatTurnTrigger;
  uiMessages: UIMessage[];
  userId: string;
  accessToken?: string;
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
    const resolved = await resolveRegenerationTurn({
      conversationId,
      messageId,
      accessToken,
    });

    return {
      continuationAssistantMessageId: null,
      claimApproval: null,
      conversation,
      ...resolved,
    };
  }

  if (lastMessage && hasApprovalResponseParts(lastMessage)) {
    const { continuationAssistantMessageId, claimApproval, userText } =
      await resolveApprovalContinuationTurn({
        conversationId,
        lastMessage,
        messageId,
      });

    return {
      continuationAssistantMessageId,
      claimApproval,
      conversation,
      userText,
      historyChange: null,
    };
  }

  const resolved = await resolveSubmitTurn({
    conversationId,
    lastMessage,
    messageId,
    accessToken,
  });

  return {
    continuationAssistantMessageId: null,
    claimApproval: null,
    conversation,
    ...resolved,
  };
}

async function resolveRegenerationTurn({
  conversationId,
  messageId,
  accessToken,
}: {
  conversationId: string;
  messageId?: string;
  accessToken?: string;
}): Promise<Pick<ChatTurnResolution, "userText" | "historyChange">> {
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

  await assertReplaceableHistory(
    existingMessages.slice(targetAssistantIndex),
    accessToken,
  );

  const precedingUserMessage = existingMessages
    .slice(0, targetAssistantIndex)
    .findLast((message) => message.role === "user");

  if (!precedingUserMessage) {
    throw new ChatTurnResolutionError(
      "No user message found to regenerate from",
      400,
    );
  }

  return {
    userText: precedingUserMessage.content,
    historyChange: {
      removeMessageIds: [existingMessages[targetAssistantIndex].id],
      userMessage: null,
    },
  };
}

async function resolveApprovalContinuationTurn({
  conversationId,
  lastMessage,
  messageId,
}: {
  conversationId: string;
  lastMessage: UIMessage;
  messageId?: string;
}): Promise<{
  continuationAssistantMessageId: string;
  claimApproval: () => void;
  userText: string;
}> {
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

  const currentMessage = existingMessages[currentMessageIndex];
  const storedParts = deserializeMessageParts(currentMessage.tool_calls) ?? [];
  const submittedParts = sanitizeMessageParts(lastMessage.parts);
  let decisionCount = 0;
  const approvedParts = storedParts.map((part) => {
    if (!isToolUIPart(part) || part.state !== "approval-requested") return part;
    const decision = submittedParts.find(
      (candidate) =>
        isToolUIPart(candidate) && candidate.toolCallId === part.toolCallId,
    );
    if (
      !decision ||
      !isToolUIPart(decision) ||
      decision.state !== "approval-responded"
    ) {
      return part;
    }
    if (
      decision.approval?.id !== part.approval.id ||
      typeof decision.approval.approved !== "boolean" ||
      (decision.approval.reason !== undefined &&
        typeof decision.approval.reason !== "string")
    ) {
      throw new ChatTurnResolutionError("Invalid approval decision", 400);
    }
    decisionCount += 1;
    return {
      ...part,
      state: "approval-responded" as const,
      approval: {
        id: part.approval.id,
        approved: decision.approval.approved,
        ...(decision.approval.reason !== undefined
          ? { reason: decision.approval.reason }
          : {}),
      },
    };
  });

  if (
    lastMessage.id !== targetMessageId ||
    decisionCount === 0 ||
    storedParts.some(
      (part) => isToolUIPart(part) && part.state === "approval-responded",
    ) ||
    approvedParts.some(
      (part) => isToolUIPart(part) && part.state === "approval-requested",
    ) ||
    !isDeepStrictEqual(approvedParts, submittedParts)
  ) {
    throw new ChatTurnResolutionError(
      "Approval does not match a pending tool call",
      400,
    );
  }

  return {
    continuationAssistantMessageId: targetMessageId,
    claimApproval: () => {
      const claimed = db
        .update(messages)
        .set({ tool_calls: serializeMessageParts(approvedParts) })
        .where(
          and(
            eq(messages.id, targetMessageId),
            eq(messages.conversation_id, conversationId),
            eq(messages.tool_calls, currentMessage.tool_calls ?? ""),
          ),
        )
        .run();
      if (claimed.changes !== 1) {
        throw new ChatTurnResolutionError("Approval has already been handled", 400);
      }
    },
    userText: precedingUserMessage.content,
  };
}

async function resolveSubmitTurn({
  conversationId,
  lastMessage,
  messageId,
  accessToken,
}: {
  conversationId: string;
  lastMessage: UIMessage | undefined;
  messageId?: string;
  accessToken?: string;
}): Promise<Pick<ChatTurnResolution, "userText" | "historyChange">> {
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

    await assertReplaceableHistory(
      existingMessages.slice(currentMessageIndex + 1),
      accessToken,
    );

    const trailingMessageIds = existingMessages
      .slice(currentMessageIndex + 1)
      .map((message) => message.id);

    return {
      userText,
      historyChange: {
        removeMessageIds: trailingMessageIds,
        userMessage: { ...lastMessage, id: messageId },
      },
    };
  }

  if (!lastMessage.id || typeof lastMessage.id !== "string") {
    throw new ChatTurnResolutionError("Message ID is required", 400);
  }
  const inserted = await db
    .insert(messages)
    .values({
      id: lastMessage.id,
      conversation_id: conversationId,
      role: "user",
      content: userText,
      tool_calls: persistedParts,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (inserted.length !== 1) {
    throw new ChatTurnResolutionError("Message ID already exists", 400);
  }

  return { userText, historyChange: null };
}

function orderedConversationMessages(conversationId: string) {
  return db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });
}

async function assertReplaceableHistory(
  history: { tool_calls: string | null }[],
  accessToken = "",
) {
  let readToolNames: string[] | undefined;
  for (const message of history) {
    for (const part of deserializeMessageParts(message.tool_calls) ?? []) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      const output = part.output;
      if (
        typeof output === "object" &&
        output !== null &&
        (("isError" in output && output.isError === true) ||
          ("error" in output && Boolean(output.error)))
      ) {
        continue;
      }
      const meta =
        typeof output === "object" && output !== null && "_meta" in output
          ? output._meta
          : undefined;
      const operation =
        typeof meta === "object" && meta !== null && "operation" in meta
          ? meta.operation
          : undefined;
      const toolName = part.type === "dynamic-tool"
        ? part.toolName : part.type.slice(5);
      let isWrite = operation === "write" ||
        (operation !== "read" && toolName === "WriteTable");
      if (part.type === "dynamic-tool" && toolName.startsWith("mcp.")) {
        try {
          readToolNames ??= (await listMcpToolNamesByOperation({ accessToken })).read;
        } catch {
          throw new ChatTurnResolutionError(
            "Unable to verify completed TYPO3 tool results. Continue with a new message so the saved tool results are retained.",
            409,
          );
        }
        isWrite = !readToolNames.includes(toolName.slice(4));
      }
      if (isWrite) {
        throw new ChatTurnResolutionError(
          "Completed TYPO3 changes cannot be retried or replaced. Continue with a new message so the saved tool results are retained.",
          409,
        );
      }
    }
  }
}
