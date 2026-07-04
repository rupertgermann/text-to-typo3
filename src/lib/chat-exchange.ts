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

const SYSTEM_PROMPT = `TYPO3 MCP operating policy:
- Use TYPO3 MCP tools when you need live data from the connected TYPO3 instance or need to change TYPO3 content.
- Before writing, read the relevant current page, record, table, or configuration context unless the user has already provided enough current data in this turn.
- Keep MCP context small: when a read, list, or search tool supports fields, limit, filters, or pagination, request only the fields and records needed for the next decision. Increase scope incrementally when the task requires it.
- If table fields, required values, relation fields, FlexForm paths, or allowed values are unclear, inspect the relevant table or FlexForm schema before writing.
- Write operations are queued as TYPO3 workspace changes. They are not live until an editor publishes them in the TYPO3 backend. Describe successful writes as queued workspace changes, not published or live changes.
- Do not ask for extra confirmation for narrow, reversible edits the user clearly requested; rely on the app's write approval gate when present. Ask for confirmation before broad, risky, destructive, or many-record changes. If a write approval is pending, wait for the user's approve or deny response.
- When a write returns validation, missing-input, or rejected-field feedback, treat the tool output as retry guidance. Adjust from the error and available schema or context, then retry unless the output proves a real blocker.
- Do not restate or depend on WriteTable parameter mechanics beyond what the active tool description and schema provide.
- Translation workflows are experimental. Only translate, localize, or update translated TYPO3 records when the user explicitly asks for translation work, and state any uncertainty before writing.

Use Web Search when a request depends on current public information, external facts outside the TYPO3 instance, or source-backed answers. Prefer TYPO3 MCP tools over Web Search for facts about the connected TYPO3 site.`;

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
