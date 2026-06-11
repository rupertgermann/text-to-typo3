import { McpHttpError } from "@/lib/mcp";

export type ChatErrorSource = "mcp" | "provider";

export function getChatErrorMessage(
  error: unknown,
  source: ChatErrorSource,
): string {
  const status = getStatusCode(error);

  if (source === "mcp") {
    if (status === 401 || status === 403) {
      return "TYPO3 MCP authentication failed. Check the configured token.";
    }

    return "TYPO3 MCP endpoint unreachable. Check Settings.";
  }

  if (status === 401 || status === 403) {
    return "Model provider authentication failed. Check the configured API key.";
  }

  if (status && status >= 400) {
    return "Model provider error. Try again or test the provider connection in Settings.";
  }

  return "Model provider unreachable. Check the endpoint in Settings.";
}

function getStatusCode(error: unknown): number | null {
  if (error instanceof McpHttpError) {
    return error.status;
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.responseStatus;

  if (typeof status === "number") {
    return status;
  }

  if (
    record.response &&
    typeof record.response === "object" &&
    "status" in record.response &&
    typeof record.response.status === "number"
  ) {
    return record.response.status;
  }

  if (error instanceof Error) {
    const match = error.message.match(/\b(4\d\d|5\d\d)\b/);
    return match ? Number(match[1]) : null;
  }

  return null;
}
