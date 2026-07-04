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
  return toolName === "WriteTable";
}

export function hasSuccessfulWriteResult(steps: AgentLoopStep[]): boolean {
  return steps.some((step) =>
    (step.toolResults ?? []).some((toolResult) => {
      const outputOperation =
        toolResult.output && typeof toolResult.output === "object"
          ? (toolResult.output as { _meta?: { operation?: string } })._meta?.operation
          : undefined;
      const isWrite =
        outputOperation === "write" || isWriteToolName(toolResult.toolName);

      if (!isWrite) {
        return false;
      }

      if (!toolResult.output || typeof toolResult.output !== "object") {
        return true;
      }

      const output = toolResult.output as { isError?: unknown };
      return output.isError !== true;
    }),
  );
}

export function getAgentLoopStepOptions({
  isChatCompletionsPath,
  userText,
  stepNumber,
  maxSteps,
  steps,
}: AgentLoopStepOptionsInput): { toolChoice: "required" } | undefined {
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
