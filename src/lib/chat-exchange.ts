import { asc, eq } from "drizzle-orm";
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
  isToolUIPart,
} from "ai";
import type { AuthenticatedUserContext } from "@/lib/auth";
import { apiError, badRequest, notFound, upstreamError } from "@/lib/api-route";
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
import { tryAcquireConversation } from "@/lib/conversation-admission";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import {
  getMcpTools,
  createMcpExecution,
  listMcpToolNamesByOperation,
  getTypo3McpUrl,
} from "@/lib/mcp";
import { hasUnknownWriteOutcome, normalizeNativeMcpOutput, unknownWriteResult } from "@/lib/mcp-outcome";
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
- If a write outcome is unknown, stop. Do not retry it or assume it failed. Tell the user to check the TYPO3 workspace and reconcile the result in a new message.
- Do not restate or depend on WriteTable parameter mechanics beyond what the active tool description and schema provide.
- Translation workflows are experimental. Only translate, localize, or update translated TYPO3 records when the user explicitly asks for translation work, and state any uncertainty before writing.

Use Web Search when a request depends on current public information, external facts outside the TYPO3 instance, or source-backed answers. Prefer TYPO3 MCP tools over Web Search for facts about the connected TYPO3 site.`;

export async function streamChatExchange({
  auth,
  conversationId,
  messageId,
  signal,
  trigger,
  uiMessages,
}: {
  auth: AuthenticatedUserContext;
  conversationId: string;
  messageId?: string;
  signal?: AbortSignal;
  trigger: ChatTurnTrigger;
  uiMessages: UIMessage[];
}): Promise<Response> {
  const release = tryAcquireConversation(auth.user.id, conversationId);
  if (!release) {
    return apiError(
      "conversation_busy",
      "This conversation is busy. Wait for the current operation to finish before sending another message.",
      409,
    );
  }
  let streaming = false;
  try {
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
        accessToken: auth.accessToken,
      });
    } catch (error) {
      if (error instanceof ChatTurnResolutionError) {
        if (error.status === 409) {
          return apiError("completed_tool_results", error.message, 409);
        }
        return error.status === 404
          ? notFound(error.message)
          : badRequest(error.message);
      }

      throw error;
    }

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

    const maxSteps = getAgentLoopMaxSteps();
    const requireWriteApproval = !Boolean(turn.conversation.auto_approve_writes);

    const execution = createMcpExecution(signal);
    const nativeApprovalNames = turn.nativeApprovalNames;
    const nativeContinuation = nativeApprovalNames.length > 0;
    let nativeReadToolNames: string[] = [];
    let tools;
    try {
      if (nativeContinuation) {
        if (providerResolution.providerKind !== "openai") {
          return badRequest("Continue the saved approval with an OpenAI model.");
        }
        nativeReadToolNames = (await listMcpToolNamesByOperation({ accessToken: auth.accessToken })).read;
      }
      tools = nativeContinuation
        ? {
            typo3: providerResolution.provider.tools.mcp({
              serverLabel: "typo3",
              serverUrl: getTypo3McpUrl(),
              requireApproval: "always",
              allowedTools: nativeApprovalNames,
              headers: auth.accessToken
                ? { Authorization: `Bearer ${auth.accessToken}` }
                : undefined,
            }),
          }
        : await getMcpTools({
            sessionId: auth.session.sessionId || `token:${auth.user.id}`,
            accessToken: auth.accessToken,
            requireWriteApproval,
            execution,
          });
    } catch (error) {
      return upstreamError(getChatErrorMessage(error, "mcp"));
    }

    if (!nativeContinuation) tools = addWebSearchTool({ providerResolution, tools });

    if (signal?.aborted) return new Response(null, { status: 204 });

    try {
      turn.claimApproval?.();
    } catch (error) {
      if (error instanceof ChatTurnResolutionError) return badRequest(error.message);
      throw error;
    }

    const dbMessages = await db.query.messages.findMany({
      where: eq(messages.conversation_id, conversationId),
      orderBy: [asc(messages.created_at)],
    });

    const originalMessages: UIMessage[] = dbMessages
      .filter((msg) => !turn.historyChange?.removeMessageIds.includes(msg.id))
      .map((msg) =>
        turn.historyChange?.userMessage?.id === msg.id
          ? turn.historyChange.userMessage
          : {
              id: msg.id,
              role: msg.role as UIMessage["role"],
              parts: deserializeMessageParts(msg.tool_calls) ?? [
                { type: "text", text: msg.content },
              ],
            },
      );

    const modelInputMessages = prepareMessagesForModelInput(originalMessages);
    const modelMessages = await convertToModelMessages(
      modelInputMessages.map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    );

    const budgetedModelMessages = budgetModelMessages(modelMessages, {
      contextWindow: providerResolution.contextWindow,
      reservedOutputTokens: 4096,
    });

    const nativeApprovedParts = nativeContinuation
      ? originalMessages.filter((message) => message.id === turn.continuationAssistantMessageId).flatMap((message) => message.parts).filter(
          (part) => part.type === "dynamic-tool" && part.toolName.startsWith("mcp.") &&
            part.state === "approval-responded" && part.approval.approved,
        )
      : [];
    if (signal?.aborted) return new Response(null, { status: 204 });

    // Stop new work without aborting the SDK stream that records dispatched writes.
    const result = streamText({
      model: providerResolution.model,
      maxRetries: 0,
      system: [SYSTEM_PROMPT, env.TYPO3_MCP_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
      messages: budgetedModelMessages,
      stopWhen: [stepCountIs(nativeContinuation ? 1 : maxSteps), () => Boolean(signal?.aborted) || execution.hasUnknownOutcome()],
      tools,
      experimental_transform: () => new TransformStream({
        transform(chunk, controller) {
          if (nativeContinuation && chunk.type === "tool-result" && chunk.toolName.startsWith("mcp.")) {
            controller.enqueue({
              ...chunk,
              output: normalizeNativeMcpOutput(chunk.output, nativeReadToolNames.includes(chunk.toolName.slice(4)) ? "read" : "write"),
            });
          } else {
            controller.enqueue(chunk);
          }
        },
      }),
      prepareStep: ({ stepNumber, steps }) => {
        signal?.throwIfAborted();
        return getAgentLoopStepOptions({
          isChatCompletionsPath: providerResolution.isChatCompletionsPath,
          userText: turn.userText,
          stepNumber,
          maxSteps,
          steps,
        });
      },
    });

    let streamFailed = false;
    const handleError = (error: unknown) => {
      streamFailed = true;
      return getChatErrorMessage(error, "provider");
    };
    const stream = createUIMessageStream({
      originalMessages: turn.continuationAssistantMessageId
        ? originalMessages
        : undefined,
      generateId: () => crypto.randomUUID(),
      onError: handleError,
      execute: async ({ writer }) => {
        const completedCalls = new Set<string>();
        const retainMissingNativeResults = () => {
          for (const part of nativeApprovedParts) {
            if (part.type !== "dynamic-tool" || completedCalls.has(part.toolCallId) || nativeReadToolNames.includes(part.toolName.slice(4))) continue;
            completedCalls.add(part.toolCallId);
            writer.write({
              type: "tool-output-available",
              toolCallId: part.toolCallId,
              output: unknownWriteResult(),
              dynamic: true,
              providerExecuted: true,
            });
          }
        };
        try {
          for await (const chunk of result.toUIMessageStream({ onError: handleError })) {
            if (chunk.type === "tool-output-available") completedCalls.add(chunk.toolCallId);
            if (chunk.type === "error" || chunk.type === "finish") retainMissingNativeResults();
            writer.write(chunk);
          }
        } finally {
          retainMissingNativeResults();
        }
      },
      onFinish: async ({ responseMessage, isAborted }) => {
        const failed = streamFailed || isAborted || signal?.aborted || responseMessage.parts.some(
          (part) => isToolUIPart(part) && part.state === "output-available" && hasUnknownWriteOutcome(part.output),
        );
        const tokenUsage = failed
          ? { inputTokens: null, outputTokens: null }
          : normalizeLanguageModelUsage(await result.totalUsage);
        const { titleGeneration } = await persistResponseMessage({
          historyChange: failed ? null : turn.historyChange,
          continuationAssistantMessageId: turn.continuationAssistantMessageId,
          conversation: turn.conversation,
          responseMessage,
          titleGenerator: failed
            ? undefined
            : createModelTitleGenerator(providerResolution.model),
          tokenUsage,
          userText: turn.userText,
        });

        void titleGeneration;
      },
    });
    const response = createUIMessageStreamResponse({
      stream,
      // Finish recording tool results even if the browser disconnects.
      consumeSseStream: ({ stream }) => {
        void consumeStream({ stream }).finally(release);
      },
    });
    streaming = true;
    return response;
  } finally {
    if (!streaming) release();
  }
}
