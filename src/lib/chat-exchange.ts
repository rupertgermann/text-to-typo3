import { asc, eq } from "drizzle-orm";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { AuthenticatedUserContext } from "@/lib/auth";
import { badRequest, notFound, upstreamError } from "@/lib/api-route";
import { getAgentLoopMaxSteps, getAgentLoopStepOptions } from "@/lib/agent-loop-policy";
import { getChatErrorMessage } from "@/lib/chat-errors";
import {
  deserializeMessageParts,
  prepareMessagesForModelInput,
} from "@/lib/chat-message-parts";
import {
  ChatProviderResolutionError,
  resolveChatProvider,
} from "@/lib/chat-provider-resolution";
import {
  ChatTurnResolutionError,
  resolveChatTurn,
  type ChatTurnTrigger,
} from "@/lib/chat-turn-resolution";
import { addWebSearchTool } from "@/lib/chat-tools";
import {
  createModelTitleGenerator,
  persistResponseMessage,
} from "@/lib/chat-turn-persistence";
import { budgetModelMessages } from "@/lib/context-budget";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import {
  getMcpTools,
  getTypo3McpUrl,
  listMcpToolNamesByOperation,
} from "@/lib/mcp";
import { getResolvedUserSettings } from "@/lib/user-settings";
import { normalizeLanguageModelUsage } from "@/lib/token-usage";

const SYSTEM_PROMPT = `You are a helpful assistant for TYPO3 CMS. You help users manage their TYPO3 website by answering questions, providing guidance, and assisting with content management tasks. Be concise, accurate, and helpful. When discussing TYPO3-specific features, refer to the correct TYPO3 version terminology and best practices. Use TYPO3 MCP tools when you need live site data or need to modify TYPO3 content. Default writes to TYPO3 workspaces, and ask for confirmation before broad changes that affect many records.

Use Web Search when a request depends on current public information, external facts outside the TYPO3 instance, or source-backed answers. Prefer TYPO3 MCP tools over Web Search for facts about the connected TYPO3 site.

When a user asks you to create or update TYPO3 content and an appropriate write tool is available, continue until the requested TYPO3 change is actually completed or you hit a real blocking error that cannot be resolved from the available tool outputs.

For TYPO3 WriteTable operations:
- For create and update actions, include a data object with the field values to write.
- If you do not yet know the required fields, inspect the schema first and then retry the write with corrected parameters.
- If a write fails with a validation or missing-input error, treat that as feedback for another attempt, not as a final blocker.
- Do not claim that a tool cannot write field values unless the tool schema or the error explicitly proves that limitation.
- After reading a page for context, continue with the needed read, schema, and write calls instead of stopping at analysis alone.`;

export async function streamChatExchange({
  auth,
  conversationId,
  messageId,
  trigger,
  uiMessages,
}: {
  auth: AuthenticatedUserContext;
  conversationId: string;
  messageId?: string;
  trigger: ChatTurnTrigger;
  uiMessages: UIMessage[];
}): Promise<Response> {
  const userId = auth.user.id;
  const env = getEnv();

  let turn;
  try {
    turn = await resolveChatTurn({
      conversationId,
      messageId,
      trigger,
      uiMessages,
      userId,
    });
  } catch (error) {
    if (error instanceof ChatTurnResolutionError) {
      return error.status === 404
        ? notFound(error.message)
        : badRequest(error.message);
    }

    throw error;
  }

  const dbMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  const originalMessages: UIMessage[] = dbMessages.map((msg) => ({
    id: msg.id,
    role: msg.role as "user" | "assistant" | "system",
    parts:
      deserializeMessageParts(msg.tool_calls) ?? [
        { type: "text", text: msg.content },
      ],
  }));

  const modelInputMessages = prepareMessagesForModelInput(originalMessages);
  const modelMessages = await convertToModelMessages(
    modelInputMessages.map((message) => ({
      role: message.role,
      parts: message.parts,
    })),
  );

  const userSettings = await getResolvedUserSettings(userId);
  let providerResolution;
  try {
    providerResolution = resolveChatProvider({
      envOpenAiApiKey: env.OPENAI_API_KEY,
      settings: userSettings,
    });
  } catch (error) {
    if (error instanceof ChatProviderResolutionError) {
      return badRequest(error.message);
    }

    throw error;
  }

  const budgetedModelMessages = budgetModelMessages(modelMessages, {
    contextWindow: providerResolution.contextWindow,
    reservedOutputTokens: 4096,
  });
  const maxSteps = getAgentLoopMaxSteps();
  const requireWriteApproval = !Boolean(turn.conversation.auto_approve_writes);

  let tools;
  try {
    if (
      providerResolution.providerKind === "openai" &&
      providerResolution.supportsBuiltInMcpTool
    ) {
      const readToolNames = requireWriteApproval
        ? (await listMcpToolNamesByOperation({
            accessToken: auth.accessToken,
          })).read
        : [];

      tools = {
        typo3: providerResolution.provider.tools.mcp({
          serverLabel: "typo3",
          serverUrl: getTypo3McpUrl(),
          serverDescription:
            "TYPO3 MCP server for reading and updating TYPO3 content and configuration.",
          requireApproval: requireWriteApproval
            ? { never: { toolNames: readToolNames } }
            : "never",
          headers: auth.accessToken
            ? { Authorization: `Bearer ${auth.accessToken}` }
            : undefined,
        }),
      };
    } else {
      tools = await getMcpTools({
        sessionId: auth.session.sessionId || `token:${auth.user.id}`,
        accessToken: auth.accessToken,
        requireWriteApproval,
      });
    }
  } catch (error) {
    return upstreamError(getChatErrorMessage(error, "mcp"));
  }

  tools = addWebSearchTool({ providerResolution, tools });

  const result = streamText({
    model: providerResolution.model,
    maxRetries: 0,
    system: [SYSTEM_PROMPT, env.TYPO3_MCP_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
    messages: budgetedModelMessages,
    stopWhen: stepCountIs(maxSteps),
    tools,
    prepareStep: ({ stepNumber, steps }) =>
      getAgentLoopStepOptions({
        isChatCompletionsPath: providerResolution.isChatCompletionsPath,
        userText: turn.userText,
        stepNumber,
        maxSteps,
        steps,
      }),
  });

  return result.toUIMessageStreamResponse({
    originalMessages,
    onError: (error) => getChatErrorMessage(error, "provider"),
    onFinish: async ({ responseMessage }) => {
      const tokenUsage = normalizeLanguageModelUsage(await result.totalUsage);
      const { titleGeneration } = await persistResponseMessage({
        continuationAssistantMessageId: turn.continuationAssistantMessageId,
        conversation: turn.conversation,
        responseMessage,
        titleGenerator: createModelTitleGenerator(providerResolution.model),
        tokenUsage,
        userText: turn.userText,
      });

      void titleGeneration;
    },
  });
}
