type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
} | null | undefined;

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export function normalizeLanguageModelUsage(usage: ProviderUsage): TokenUsage {
  return {
    inputTokens: normalizeTokenCount(usage?.inputTokens),
    outputTokens: normalizeTokenCount(usage?.outputTokens),
  };
}

export function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const usage of usages) {
    if (usage.inputTokens !== null) {
      inputTokens = (inputTokens ?? 0) + usage.inputTokens;
    }

    if (usage.outputTokens !== null) {
      outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    }
  }

  return { inputTokens, outputTokens };
}

export function formatTokenUsage(usage: TokenUsage): string {
  if (usage.inputTokens === null && usage.outputTokens === null) {
    return "Usage unknown";
  }

  const input =
    usage.inputTokens === null ? "input unknown" : `${usage.inputTokens} in`;
  const output =
    usage.outputTokens === null ? "output unknown" : `${usage.outputTokens} out`;

  return `${input}, ${output}`;
}

function normalizeTokenCount(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
