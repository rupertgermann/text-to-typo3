import { isRecord } from "@/lib/mcp-result-content";

export type ChangeTarget = "workspace" | "storage";

export const UNKNOWN_WRITE_MESSAGE =
  "The TYPO3 write outcome is unknown. It may have completed. Check the TYPO3 workspace before making further changes; continue with a new message to reconcile the result.";
const UNKNOWN_STORAGE_WRITE_MESSAGE = UNKNOWN_WRITE_MESSAGE.replace("workspace", "file storage");

export function getChangeTarget(toolName: string): ChangeTarget | undefined {
  const name = toolName.replace(/^mcp\./, "");
  if (name === "WriteTable") return "workspace";
  if (name === "UploadFile") return "storage";
}

export function getUnknownWriteMessage(target?: ChangeTarget): string {
  return target === "storage" ? UNKNOWN_STORAGE_WRITE_MESSAGE : UNKNOWN_WRITE_MESSAGE;
}

export function getMcpOutputMeta(output: unknown): Record<string, unknown> | undefined {
  return isRecord(output) && isRecord(output._meta) ? output._meta : undefined;
}

export function hasUnknownWriteOutcome(output: unknown): boolean {
  const meta = getMcpOutputMeta(output);
  return meta?.operation === "write" && meta.outcome === "unknown";
}

export function unknownWriteResult(changeTarget?: ChangeTarget) {
  return {
    isError: true,
    content: [{ type: "text", text: getUnknownWriteMessage(changeTarget) }],
    _meta: { operation: "write", outcome: "unknown", changeTarget },
  };
}
