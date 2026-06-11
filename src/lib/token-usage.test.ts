import { describe, expect, it } from "vitest";
import {
  formatTokenUsage,
  normalizeLanguageModelUsage,
  sumTokenUsage,
} from "./token-usage";

describe("token usage helpers", () => {
  it("normalizes provider usage without turning missing values into zero", () => {
    expect(
      normalizeLanguageModelUsage({ inputTokens: 12, outputTokens: 7 }),
    ).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(
      normalizeLanguageModelUsage({ inputTokens: undefined, outputTokens: 7 }),
    ).toEqual({ inputTokens: null, outputTokens: 7 });
    expect(normalizeLanguageModelUsage(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("sums known values and ignores unknown values", () => {
    expect(
      sumTokenUsage([
        { inputTokens: 10, outputTokens: null },
        { inputTokens: null, outputTokens: 3 },
        { inputTokens: 5, outputTokens: 4 },
      ]),
    ).toEqual({ inputTokens: 15, outputTokens: 7 });

    expect(
      sumTokenUsage([
        { inputTokens: null, outputTokens: null },
        { inputTokens: null, outputTokens: null },
      ]),
    ).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("formats unknown usage explicitly", () => {
    expect(formatTokenUsage({ inputTokens: null, outputTokens: null })).toBe(
      "Usage unknown",
    );
    expect(formatTokenUsage({ inputTokens: 15, outputTokens: null })).toBe(
      "15 in, output unknown",
    );
    expect(formatTokenUsage({ inputTokens: 15, outputTokens: 7 })).toBe(
      "15 in, 7 out",
    );
  });
});
