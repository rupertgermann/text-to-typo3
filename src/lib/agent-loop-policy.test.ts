import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_LOOP_MAX_STEPS,
  getAgentLoopMaxSteps,
  getAgentLoopStepOptions,
  hasSuccessfulWriteResult,
  isTypo3MutationRequest,
} from "./agent-loop-policy";

describe("agent loop policy", () => {
  it("uses a configurable step cap with a default of 12", () => {
    expect(getAgentLoopMaxSteps({})).toBe(DEFAULT_AGENT_LOOP_MAX_STEPS);
    expect(getAgentLoopMaxSteps({ TYPO3_AGENT_MAX_STEPS: "7" })).toBe(7);
    expect(getAgentLoopMaxSteps({ TYPO3_AGENT_MAX_STEPS: "0" })).toBe(
      DEFAULT_AGENT_LOOP_MAX_STEPS,
    );
    expect(getAgentLoopMaxSteps({ TYPO3_AGENT_MAX_STEPS: "not-a-number" })).toBe(
      DEFAULT_AGENT_LOOP_MAX_STEPS,
    );
  });

  it("detects English and German TYPO3 mutation requests", () => {
    expect(isTypo3MutationRequest("Create three news records on page 67")).toBe(
      true,
    );
    expect(isTypo3MutationRequest("Erstelle drei Newsartikel auf Seite 67")).toBe(
      true,
    );
    expect(isTypo3MutationRequest("Übersetze diese Seite ins Englische")).toBe(
      true,
    );
    expect(isTypo3MutationRequest("Show me the page tree")).toBe(false);
  });

  it("keeps chat-completions models in tool mode until a write succeeds", () => {
    expect(
      getAgentLoopStepOptions({
        isChatCompletionsPath: true,
        userText: "Erstelle drei Newsartikel",
        stepNumber: 2,
        maxSteps: 12,
        steps: [],
      }),
    ).toEqual({ toolChoice: "required" });

    expect(
      getAgentLoopStepOptions({
        isChatCompletionsPath: false,
        userText: "Erstelle drei Newsartikel",
        stepNumber: 2,
        maxSteps: 12,
        steps: [],
      }),
    ).toBeUndefined();

    expect(
      getAgentLoopStepOptions({
        isChatCompletionsPath: true,
        userText: "Erstelle drei Newsartikel",
        stepNumber: 11,
        maxSteps: 12,
        steps: [],
      }),
    ).toBeUndefined();
  });

  it("treats non-error write tool results as successful writes", () => {
    expect(
      hasSuccessfulWriteResult([
        {
          toolResults: [
            { toolName: "ReadTable", output: { isError: false } },
            { toolName: "WriteTable", output: { isError: true } },
          ],
        },
      ]),
    ).toBe(false);

    const successfulSteps = [
      {
        toolResults: [
          { toolName: "WriteTable", output: { recordUid: 123 } },
        ],
      },
    ];

    expect(hasSuccessfulWriteResult(successfulSteps)).toBe(true);
    expect(
      getAgentLoopStepOptions({
        isChatCompletionsPath: true,
        userText: "Create a news record",
        stepNumber: 3,
        maxSteps: 12,
        steps: successfulSteps,
      }),
    ).toBeUndefined();
  });

  it("uses operation metadata to detect successful writes", () => {
    expect(
      hasSuccessfulWriteResult([
        {
          toolResults: [
            {
              toolName: "AnnotatedDangerousTool",
              output: {
                uid: 123,
                _meta: { operation: "write" },
              },
            },
          ],
        },
      ]),
    ).toBe(true);
  });
});
