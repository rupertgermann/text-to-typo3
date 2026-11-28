import { getToolName, isFileUIPart, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import { containsUploadTicket, getMcpRecordContent, localUploadResult, mcpResultForDisclosure, redactTypo3PreviewUrls } from "@/lib/mcp-result-content";

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
  const latestUserIndex = messages.findLastIndex(({ role }) => role === "user");
  const seenToolCallIds = new Set<string>();
  const prepared: UIMessage[] = [];

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const sanitizedParts = messagePartsForDisclosure(sanitizeMessageParts(message.parts));
    const nextParts: UIMessage["parts"] = [];

    for (let partIndex = sanitizedParts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = sanitizedParts[partIndex];

      if (isToolUIPart(part)) {
        if (messageIndex < latestUserIndex && part.type === "dynamic-tool" &&
          part.toolName.startsWith("mcp.") &&
          (part.state === "approval-requested" || part.state === "output-denied")) continue;
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

export function messagePartsForDisclosure(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.map((part) => {
    if (!isRecord(part)) return part;
    if (part.type === "text" || part.type === "reasoning") {
      return { ...part, text: redactTypo3PreviewUrls(part.text) };
    }
    if (part.type === "source-url" || part.type === "file") return { ...part, url: redactTypo3PreviewUrls(part.url) };
    if (!isToolUIPart(part)) return part;

    const input = part.input === undefined ? undefined : getMcpRecordContent(part.input).output;
    if (part.state === "output-available") {
      return { ...part, input, output: mcpResultForDisclosure(part.output, getToolName(part)) };
    }
    if (part.state === "output-error") {
      return { ...part, input, errorText: redactTypo3PreviewUrls(part.errorText) };
    }
    return { ...part, input };
  });
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
  if ((part.type === "tool-UploadFile" || (part.type === "dynamic-tool" && part.toolName === "mcp.UploadFile")) &&
    part.state === "output-available" && containsUploadTicket(part.output)) {
    nextPart.output = {
      ...localUploadResult("unavailable"),
      _meta: { operation: "write", changeTarget: "storage", outcome: "rejected" },
    };
  }

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
