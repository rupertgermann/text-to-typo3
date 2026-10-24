export const UNKNOWN_WRITE_MESSAGE =
  "The TYPO3 write outcome is unknown. It may have completed. Check the TYPO3 workspace before making further changes; continue with a new message to reconcile the result.";

export function hasUnknownWriteOutcome(output: unknown): boolean {
  if (!output || typeof output !== "object" || !("_meta" in output)) return false;
  const meta = output._meta;
  return typeof meta === "object" && meta !== null &&
    "operation" in meta && meta.operation === "write" &&
    "outcome" in meta && meta.outcome === "unknown";
}

export function unknownWriteResult() {
  return {
    isError: true,
    content: [{ type: "text", text: UNKNOWN_WRITE_MESSAGE }],
    _meta: { operation: "write", outcome: "unknown" },
  };
}

export function normalizeNativeMcpOutput(output: unknown, operation: "read" | "write"): unknown {
  if (!output || typeof output !== "object") {
    return operation === "write" ? unknownWriteResult() : output;
  }
  if (operation === "read") return { ...output, _meta: { operation } };
  if (("error" in output && output.error) || !("output" in output) || typeof output.output !== "string") {
    return { ...output, ...unknownWriteResult() };
  }
  let result: unknown;
  try {
    result = JSON.parse(output.output);
  } catch {
    return { ...output, ...unknownWriteResult() };
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ...output, ...unknownWriteResult() };
  }
  const rejected = "isError" in result && result.isError === true;
  return { ...output, isError: rejected, _meta: { operation, outcome: rejected ? "rejected" : "confirmed" } };
}
