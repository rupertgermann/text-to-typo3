import type { ModelMessage, ToolResultPart } from "ai";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 16000;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 2048;
const DEFAULT_CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 0.85;
const CONDENSED_TOOL_OUTPUT_MAX_CHARS = 600;

type ContextBudgetOptions = {
  contextWindow?: number | null;
  reservedOutputTokens?: number;
};

type CondensibleToolOutput = {
  messageIndex: number;
  partIndex: number;
  part: ToolResultPart;
  originalCharacters: number;
};

export function resolveContextWindow(
  contextWindow: number | null | undefined,
): number {
  return Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0
    ? Number(contextWindow)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function estimateModelMessageTokens(messages: ModelMessage[]): number {
  const serialized = JSON.stringify(messages);
  return Math.ceil(serialized.length / DEFAULT_CHARS_PER_TOKEN) + messages.length * 4;
}

export function budgetModelMessages(
  messages: ModelMessage[],
  options: ContextBudgetOptions,
): ModelMessage[] {
  const contextWindow = resolveContextWindow(options.contextWindow);
  const reservedOutputTokens =
    options.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  const availableTokens = Math.max(
    1,
    Math.floor(contextWindow * SAFETY_MARGIN) - reservedOutputTokens,
  );

  if (estimateModelMessageTokens(messages) <= availableTokens) {
    return messages;
  }

  let budgeted = messages.map(cloneMessage);

  while (estimateModelMessageTokens(budgeted) > availableTokens) {
    if (condenseNextToolOutput(budgeted)) {
      continue;
    }

    const dropped = dropOldestCompleteTurn(budgeted);
    if (!dropped) {
      break;
    }

    budgeted = dropped;
  }

  return budgeted;
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return structuredClone(message);
}

function condenseNextToolOutput(messages: ModelMessage[]): boolean {
  const match = findCondensibleToolOutput(messages);
  if (!match) {
    return false;
  }

  const message = messages[match.messageIndex];
  if (message.role !== "tool" || !Array.isArray(message.content)) {
    return false;
  }

  message.content[match.partIndex] = {
    ...match.part,
    output: {
      type: "json",
      value: {
        condensed: true,
        toolName: match.part.toolName,
        originalCharacters: match.originalCharacters,
        summary:
          "Oversized TYPO3 tool output was condensed to fit the model context budget.",
      },
    },
  };

  return true;
}

function findCondensibleToolOutput(
  messages: ModelMessage[],
): CondensibleToolOutput | null {
  const latestUserIndex = findLatestUserIndex(messages);

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    if (messageIndex >= latestUserIndex) {
      break;
    }

    const message = messages[messageIndex];
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
      const part = message.content[partIndex];
      if (part.type !== "tool-result") {
        continue;
      }

      const originalCharacters = JSON.stringify(part.output).length;
      const alreadyCondensed =
        part.output.type === "json" &&
        typeof part.output.value === "object" &&
        part.output.value !== null &&
        "condensed" in part.output.value;

      if (
        originalCharacters > CONDENSED_TOOL_OUTPUT_MAX_CHARS &&
        !alreadyCondensed
      ) {
        return { messageIndex, partIndex, part, originalCharacters };
      }
    }
  }

  return null;
}

function dropOldestCompleteTurn(messages: ModelMessage[]): ModelMessage[] | null {
  const latestUserIndex = findLatestUserIndex(messages);

  for (let start = 0; start < messages.length; start += 1) {
    if (messages[start].role === "system") {
      continue;
    }

    if (start >= latestUserIndex) {
      return null;
    }

    let end = start + 1;
    while (end < messages.length && messages[end].role !== "user") {
      end += 1;
    }

    return [...messages.slice(0, start), ...messages.slice(end)];
  }

  return null;
}

function findLatestUserIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }

  return messages.length;
}
