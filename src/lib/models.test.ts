import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenAICompatibleModels,
  getModelContextWindowLabel,
  getModelContextWindowShortLabel,
  getSelectedModelSummary,
  listOpenAIModels,
} from "./models";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model context window labels", () => {
  it("formats full labels for known and unknown context windows", () => {
    expect(getModelContextWindowLabel(null)).toBe("Context window unknown");
    expect(getModelContextWindowLabel(128000)).toBe(
      "Context window 128,000 tokens",
    );
  });

  it("formats compact labels for picker chips", () => {
    expect(getModelContextWindowShortLabel(null)).toBe("Context unknown");
    expect(getModelContextWindowShortLabel(32000)).toBe("32k ctx");
    expect(getModelContextWindowShortLabel(1000000)).toBe("1M ctx");
    expect(getModelContextWindowShortLabel(1_050_000)).toBe("1.05M ctx");
    expect(getModelContextWindowShortLabel(512)).toBe("512 ctx");
  });
});

describe("selected model summary", () => {
  it("uses the effective default chat model without fetching catalogs", () => {
    expect(getSelectedModelSummary({ modelId: null })).toEqual({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      providerName: "OpenAI",
    });
  });

  it("labels selected LM Studio models from persisted settings", () => {
    expect(
      getSelectedModelSummary({
        modelId: "local-content-model",
        lmstudioModelId: "local-content-model",
      }),
    ).toEqual({
      id: "local-content-model",
      name: "local content model",
      providerName: "LM Studio",
    });
  });

  it("labels selected custom provider models without loading provider catalogs", () => {
    expect(
      getSelectedModelSummary({
        modelId: "custom:staging:typo3-editor-32k",
        customProviders: [
          {
            id: "staging",
            displayName: "Staging endpoint",
          },
        ],
      }),
    ).toEqual({
      id: "custom:staging:typo3-editor-32k",
      name: "typo3 editor 32k",
      providerName: "Staging endpoint",
    });
  });
});

describe("OpenAI model catalog filtering", () => {
  it("keeps only the curated latest OpenAI models from the API catalog", async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignals.push(init?.signal);
        return Response.json({
          data: [
            { id: "gpt-6-luna" },
            { id: "gpt-6.2-sol" },
            { id: "gpt-6.2-astra" },
            { id: "gpt-6.1-terra" },
            { id: "gpt-5.5" },
            { id: "gpt-5.4" },
            { id: "text-embedding-3-large" },
            { id: "gpt-5.4-mini" },
            { id: "gpt-6-alpha" },
            { id: "gpt-4o" },
            { id: "gpt-image-1" },
            { id: "omni-moderation-latest" },
            { id: "gpt-4o-realtime-preview" },
            { id: "tts-1" },
            { id: "whisper-1" },
            { id: "o4-mini" },
          ],
        });
      }),
    );

    const models = await listOpenAIModels("test-key");

    expect(seenSignals).toEqual([expect.any(AbortSignal)]);
    expect(models.map((model) => model.id)).toEqual([
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
    ]);
    for (const model of models) {
      expect(model).toMatchObject({ provider: "openai", contextWindow: 1_050_000 });
    }
  });

  it("passes an AbortSignal to OpenAI-compatible model fetches", async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignals.push(init?.signal);
        return Response.json({
          data: [{ id: "local-chat" }],
        });
      }),
    );

    await fetchOpenAICompatibleModels({
      baseUrl: "http://127.0.0.1:1234",
      displayName: "Local",
      id: "local",
      provider: "custom",
    });

    expect(seenSignals).toEqual([expect.any(AbortSignal)]);
  });
});
