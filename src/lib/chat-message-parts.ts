import { isFileUIPart, isTextUIPart, type UIMessage } from "ai";

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
  return JSON.stringify(parts);
}

export function deserializeMessageParts(
  value: string | null | undefined,
): UIMessage["parts"] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as UIMessage["parts"]) : null;
  } catch {
    return null;
  }
}
