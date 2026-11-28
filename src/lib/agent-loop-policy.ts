import { getChangeTarget, getMcpOutputMeta } from "@/lib/mcp-outcome";
import { isRecord } from "@/lib/mcp-result-content";

export const DEFAULT_AGENT_LOOP_MAX_STEPS = 12;

type EnvLike = {
  [key: string]: string | undefined;
  TYPO3_AGENT_MAX_STEPS?: string;
};

export type AgentLoopToolResult = {
  toolName: string;
  output?: unknown;
};

export type AgentLoopStep = {
  toolResults?: AgentLoopToolResult[];
};

type AgentLoopStepOptionsInput = {
  isChatCompletionsPath: boolean;
  userText: string;
  stepNumber: number;
  maxSteps: number;
  steps: AgentLoopStep[];
  pendingUpload?: boolean;
};

const mutationWords = new Set([
  "add",
  "append",
  "change",
  "create",
  "delete",
  "edit",
  "insert",
  "move",
  "publish",
  "remove",
  "rename",
  "set",
  "translate",
  "update",
  "upload",
  "write",
  "aktualisieren",
  "aktualisiere",
  "anlegen",
  "erstelle",
  "erstellen",
  "erzeugen",
  "erzeuge",
  "hinzufuegen",
  "hinzufügen",
  "hochladen",
  "hochzuladen",
  "lege",
  "loesche",
  "loeschen",
  "lösche",
  "löschen",
  "schreiben",
  "schreibe",
  "setzen",
  "uebersetze",
  "uebersetzen",
  "umbenennen",
  "verschieben",
  "veröffentlichen",
  "veroefentlichen",
  "übersetze",
  "übersetzen",
  "ändern",
  "ändere",
]);

export function getAgentLoopMaxSteps(
  env: EnvLike = process.env,
): number {
  const configured = Number.parseInt(env.TYPO3_AGENT_MAX_STEPS ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_LOOP_MAX_STEPS;
}

export function isTypo3MutationRequest(text: string): boolean {
  const words = text.toLocaleLowerCase("de-DE").match(/\p{L}+/gu) ?? [];
  return words.some((word) => mutationWords.has(word));
}

export function isWriteToolName(toolName: string): boolean {
  return getChangeTarget(toolName) !== undefined;
}

export function hasSuccessfulWriteResult(steps: AgentLoopStep[]): boolean {
  return steps.some((step) =>
    (step.toolResults ?? []).some((toolResult) => {
      const meta = getMcpOutputMeta(toolResult.output);
      const isWrite = meta?.operation === "write" || isWriteToolName(toolResult.toolName);

      return isWrite && meta?.outcome !== "pending" &&
        (!isRecord(toolResult.output) || toolResult.output.isError !== true);
    }),
  );
}

export function getAgentLoopStepOptions({
  isChatCompletionsPath,
  userText,
  stepNumber,
  maxSteps,
  steps,
  pendingUpload,
}: AgentLoopStepOptionsInput): { toolChoice: "required" | "none" } | undefined {
  if (pendingUpload || steps.some((step) =>
    step.toolResults?.some(({ output }) => getMcpOutputMeta(output)?.outcome === "pending"))) {
    return { toolChoice: "none" };
  }
  if (
    !isChatCompletionsPath ||
    !isTypo3MutationRequest(userText) ||
    hasSuccessfulWriteResult(steps)
  ) {
    return undefined;
  }

  if (stepNumber < maxSteps - 1) {
    return { toolChoice: "required" };
  }

  return undefined;
}
