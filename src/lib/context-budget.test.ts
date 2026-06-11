import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  budgetModelMessages,
  estimateModelMessageTokens,
  resolveContextWindow,
} from "./context-budget";

function toolMessage(value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "ReadTable",
        output: { type: "json", value: { rows: value } },
      },
    ],
  };
}

describe("context budgeting", () => {
  it("passes conversations under budget through unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "TYPO3 assistant" },
      { role: "user", content: "Show the page tree" },
    ];

    expect(
      budgetModelMessages(messages, {
        contextWindow: 8000,
        reservedOutputTokens: 1000,
      }),
    ).toBe(messages);
  });

  it("condenses old oversized tool outputs before dropping turns", () => {
    const largeOutput = "x".repeat(5000);
    const messages: ModelMessage[] = [
      { role: "system", content: "TYPO3 assistant" },
      { role: "user", content: "Read all content records" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "ReadTable",
            input: { table: "tt_content" },
          },
        ],
      },
      toolMessage(largeOutput),
      { role: "user", content: "Summarize the newest content" },
    ];

    const budgeted = budgetModelMessages(messages, {
      contextWindow: 700,
      reservedOutputTokens: 100,
    });

    expect(budgeted).toHaveLength(messages.length);
    expect(budgeted.at(-1)).toEqual(messages.at(-1));
    expect(JSON.stringify(budgeted)).toContain("condensed");
    expect(estimateModelMessageTokens(budgeted)).toBeLessThan(
      estimateModelMessageTokens(messages),
    );
  });

  it("drops oldest complete turns while preserving system and latest user", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "TYPO3 assistant" },
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer ".repeat(500) },
      { role: "user", content: "Newest question" },
    ];

    const budgeted = budgetModelMessages(messages, {
      contextWindow: 80,
      reservedOutputTokens: 20,
    });

    expect(budgeted).toEqual([
      { role: "system", content: "TYPO3 assistant" },
      { role: "user", content: "Newest question" },
    ]);
  });

  it("uses a conservative default for unknown context windows", () => {
    expect(resolveContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow(128000)).toBe(128000);
  });
});
