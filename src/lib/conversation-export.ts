import { deserializeMessageParts, messagePartsForDisclosure } from "@/lib/chat-message-parts";
import type { Conversation, Message } from "@/lib/db/schema";
import { getMcpRecordContent, redactTypo3PreviewUrls } from "@/lib/mcp-result-content";

function formatTimestamp(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) {
    return "Unknown";
  }

  return new Date(epochSeconds * 1000).toISOString();
}

function formatToolCalls(toolCalls: string | null): string | null {
  if (!toolCalls) {
    return null;
  }

  const parts = deserializeMessageParts(toolCalls);
  if (parts) return JSON.stringify(messagePartsForDisclosure(parts), null, 2);
  try {
    const parsed: unknown = JSON.parse(toolCalls);
    return JSON.stringify(getMcpRecordContent(parsed).output, null, 2);
  } catch {
    return redactTypo3PreviewUrls(toolCalls);
  }
}

export function conversationToMarkdown(
  conversation: Conversation,
  conversationMessages: Message[],
): string {
  const lines: string[] = [
    `# ${redactTypo3PreviewUrls(conversation.title)}`,
    "",
    `- Conversation ID: ${conversation.id}`,
    `- Created: ${formatTimestamp(conversation.created_at)}`,
    `- Updated: ${formatTimestamp(conversation.updated_at)}`,
    "",
  ];

  for (const message of conversationMessages) {
    const roleLabel =
      message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Assistant"
          : "Tool";

    lines.push(`## ${roleLabel}`);
    lines.push("");
    lines.push(redactTypo3PreviewUrls(message.content || ""));

    const toolCalls = formatToolCalls(message.tool_calls ?? null);
    if (toolCalls) {
      lines.push("");
      lines.push("### Tool Calls");
      lines.push("");
      lines.push("```json");
      lines.push(toolCalls);
      lines.push("```");
    }

    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export function conversationExportFilename(title: string): string {
  const slug = redactTypo3PreviewUrls(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${slug || "conversation"}.md`;
}
