import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelContextWindowLabel,
  getModelContextWindowShortLabel,
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
    expect(getModelContextWindowShortLabel(512)).toBe("512 ctx");
  });
});

describe("OpenAI model catalog filtering", () => {
  it("keeps only the curated latest OpenAI models from the API catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
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
        }),
      ),
    );

    const models = await listOpenAIModels("test-key");

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(models[0]).toMatchObject({
      name: "GPT-5.5",
      provider: "openai",
      contextWindow: 400000,
      description: "A new class of intelligence for coding and professional work.",
    });
  });
});
