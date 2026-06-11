import { type NextRequest } from "next/server";
import { eq, and, asc, inArray } from "drizzle-orm";
import { stepCountIs, streamText, convertToModelMessages, type UIMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getMcpTools, getTypo3McpUrl } from "@/lib/mcp";
import { getResolvedUserSettings } from "@/lib/user-settings";
import {
  deserializeMessageParts,
  extractMessageText,
  hasFileParts,
  serializeMessageParts,
} from "@/lib/chat-message-parts";
import {
  getAgentLoopMaxSteps,
  getAgentLoopStepOptions,
} from "@/lib/agent-loop-policy";
import { budgetModelMessages } from "@/lib/context-budget";
import { getModelContextWindowHint, listLmStudioModels } from "@/lib/models";
import { normalizeLanguageModelUsage } from "@/lib/token-usage";

const SYSTEM_PROMPT = `You are a helpful assistant for TYPO3 CMS. You help users manage their TYPO3 website by answering questions, providing guidance, and assisting with content management tasks. Be concise, accurate, and helpful. When discussing TYPO3-specific features, refer to the correct TYPO3 version terminology and best practices. Use TYPO3 MCP tools when you need live site data or need to modify TYPO3 content. Default writes to TYPO3 workspaces, and ask for confirmation before broad changes that affect many records.

When a user asks you to create or update TYPO3 content and an appropriate write tool is available, continue until the requested TYPO3 change is actually completed or you hit a real blocking error that cannot be resolved from the available tool outputs.

For TYPO3 WriteTable operations:
- For create and update actions, include a data object with the field values to write.
- If you do not yet know the required fields, inspect the schema first and then retry the write with corrected parameters.
- If a write fails with a validation or missing-input error, treat that as feedback for another attempt, not as a final blocker.
- Do not claim that a tool cannot write field values unless the tool schema or the error explicitly proves that limitation.
- After reading a page for context, continue with the needed read, schema, and write calls instead of stopping at analysis alone.`;

function getConversationTitle(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

function supportsBuiltInMcpTool(modelId: string): boolean {
  return modelId.trim().toLowerCase() === "gpt-5.4-nano";
}

export async function POST(request: NextRequest) {
  // Validate session
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = auth.user.id;

  let body: {
    messages?: unknown;
    conversationId?: unknown;
    messageId?: unknown;
    trigger?: unknown;
  };
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
  const trigger =
    body.trigger === "regenerate-message" ? "regenerate-message" : "submit-message";

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

  const uiMessages = incomingMessages as UIMessage[];
  const lastMessage = uiMessages[uiMessages.length - 1];
  let userText = "";

  if (trigger === "regenerate-message") {
    const existingMessages = await db.query.messages.findMany({
      where: eq(messages.conversation_id, conversationId),
      orderBy: [asc(messages.created_at)],
    });
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
      return Response.json(
        { error: "Only the latest assistant message can be regenerated" },
        { status: 400 },
      );
    }

    const precedingUserMessage = existingMessages
      .slice(0, targetAssistantIndex)
      .findLast((message) => message.role === "user");

    if (!precedingUserMessage) {
      return Response.json(
        { error: "No user message found to regenerate from" },
        { status: 400 },
      );
    }

    userText = precedingUserMessage.content;

    await db
      .delete(messages)
      .where(eq(messages.id, existingMessages[targetAssistantIndex].id));
  } else {
    userText = lastMessage ? extractMessageText(lastMessage.parts) : "";

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
  const modelId = userSettings.modelId || "gpt-5.4-mini";
  const lmStudioModelContextWindow = useLmStudio && userSettings.lmstudioBaseUrl
    ? (await listLmStudioModels(userSettings.lmstudioBaseUrl)).find(
        (model) => model.id === modelId,
      )?.contextWindow
    : null;
  const budgetedModelMessages = budgetModelMessages(modelMessages, {
    contextWindow: lmStudioModelContextWindow ?? getModelContextWindowHint(modelId),
    reservedOutputTokens: 4096,
  });
  const openAiApiKey =
    userSettings.openAiApiKey || env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  if (!useLmStudio && !openAiApiKey) {
    return Response.json(
      { error: "Missing OpenAI API key. Add one in settings or .env.local." },
      { status: 400 },
    );
  }

  const provider = createOpenAI({
    apiKey: useLmStudio ? "lm-studio" : openAiApiKey,
    baseURL: useLmStudio ? userSettings.lmstudioBaseUrl || undefined : undefined,
  });
  const maxSteps = getAgentLoopMaxSteps();

  const tools = !useLmStudio && supportsBuiltInMcpTool(modelId)
    ? {
        typo3: provider.tools.mcp({
          serverLabel: "typo3",
          serverUrl: getTypo3McpUrl(),
          serverDescription:
            "TYPO3 MCP server for reading and updating TYPO3 content and configuration.",
          headers: auth.accessToken
            ? { Authorization: `Bearer ${auth.accessToken}` }
            : undefined,
        }),
      }
    : await getMcpTools({
        sessionId: auth.session.sessionId || `token:${auth.user.id}`,
        accessToken: auth.accessToken,
      });

  const result = streamText({
    model: useLmStudio ? provider.chat(modelId) : provider.responses(modelId),
    system: [SYSTEM_PROMPT, env.TYPO3_MCP_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
    messages: budgetedModelMessages,
    stopWhen: stepCountIs(maxSteps),
    tools,
    prepareStep: ({ stepNumber, steps }) =>
      getAgentLoopStepOptions({
        isChatCompletionsPath: useLmStudio,
        userText,
        stepNumber,
        maxSteps,
        steps,
      }),
  });

  return result.toUIMessageStreamResponse({
    originalMessages,
    onError: (error) =>
      error instanceof Error ? error.message : "Chat request failed",
    onFinish: async ({ responseMessage }) => {
      const assistantText = extractMessageText(responseMessage.parts);
      const tokenUsage = normalizeLanguageModelUsage(await result.totalUsage);

      if (assistantText.trim() || responseMessage.parts.some((part) => part.type.startsWith("tool-"))) {
        await db.insert(messages).values({
          conversation_id: conversationId,
          role: "assistant",
          content: assistantText,
          tool_calls: serializeMessageParts(responseMessage.parts),
          input_tokens: tokenUsage.inputTokens,
          output_tokens: tokenUsage.outputTokens,
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
