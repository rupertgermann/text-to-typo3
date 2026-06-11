import { isFileUIPart, isTextUIPart, isToolUIPart, type UIMessage } from "ai";

export function extractMessageText(parts: UIMessage["parts"]): string {
  return parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("\n");
}

export function hasFileParts(parts: UIMessage["parts"]): boolean {
  return parts.some(isFileUIPart);
}

export function serializeMessageParts(parts: UIMessage["parts"]): string {
  return JSON.stringify(sanitizeMessageParts(parts));
}

export function deserializeMessageParts(
  value: string | null | undefined,
): UIMessage["parts"] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? sanitizeMessageParts(parsed as UIMessage["parts"])
      : null;
  } catch {
    return null;
  }
}

export function prepareMessagesForModelInput(
  messages: UIMessage[],
): UIMessage[] {
  const seenToolCallIds = new Set<string>();
  const prepared: UIMessage[] = [];

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const sanitizedParts = sanitizeMessageParts(message.parts);
    const nextParts: UIMessage["parts"] = [];

    for (let partIndex = sanitizedParts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = sanitizedParts[partIndex];

      if (isToolUIPart(part)) {
        if (seenToolCallIds.has(part.toolCallId)) {
          continue;
        }

        seenToolCallIds.add(part.toolCallId);
      }

      nextParts.unshift(part);
    }

    if (
      message.role === "assistant" &&
      !nextParts.some((part) => part.type !== "step-start")
    ) {
      continue;
    }

    prepared.unshift({
      ...message,
      parts: nextParts,
    });
  }

  return prepared;
}

export function sanitizeMessageParts(
  parts: UIMessage["parts"],
): UIMessage["parts"] {
  return parts.map(sanitizeMessagePart);
}

function sanitizeMessagePart(
  part: UIMessage["parts"][number],
): UIMessage["parts"][number] {
  if (!isRecord(part)) {
    return part;
  }

  const nextPart: Record<string, unknown> = { ...part };

  sanitizeProviderMetadataProperty(nextPart, "providerMetadata");
  sanitizeProviderMetadataProperty(nextPart, "callProviderMetadata");
  sanitizeProviderMetadataProperty(nextPart, "resultProviderMetadata");

  return nextPart as UIMessage["parts"][number];
}

function sanitizeProviderMetadataProperty(
  target: Record<string, unknown>,
  property: string,
) {
  const sanitized = sanitizeReplayUnsafeProviderMetadata(target[property]);

  if (sanitized) {
    target[property] = sanitized;
    return;
  }

  delete target[property];
}

function sanitizeReplayUnsafeProviderMetadata(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const nextMetadata: Record<string, unknown> = { ...value };

  for (const providerName of ["openai", "azure"]) {
    const providerMetadata = nextMetadata[providerName];
    if (!isRecord(providerMetadata)) {
      continue;
    }

    const nextProviderMetadata = { ...providerMetadata };
    delete nextProviderMetadata.itemId;
    delete nextProviderMetadata.responseId;

    if (Object.keys(nextProviderMetadata).length > 0) {
      nextMetadata[providerName] = nextProviderMetadata;
    } else {
      delete nextMetadata[providerName];
    }
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
