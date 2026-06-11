import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedUserSettings } from "@/lib/user-settings";
import {
  ChatProviderResolutionError,
  resolveChatProvider,
} from "./chat-provider-resolution";

describe("chat provider resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the OpenAI default model when an API key is configured", () => {
    const resolution = resolveChatProvider({
      envOpenAiApiKey: "sk-test",
      settings: settings({ modelId: null }),
    });

    expect(resolution.providerKind).toBe("openai");
    expect(resolution.configuredModelId).toBe("gpt-5.4-mini");
    expect(resolution.modelId).toBe("gpt-5.4-mini");
    expect(resolution.contextWindow).toBe(400000);
    expect(resolution.isChatCompletionsPath).toBe(false);
    expect(resolution.model).toBeTruthy();
  });

  it("resolves LM Studio when the selected model matches the local model", () => {
    const resolution = resolveChatProvider({
      envOpenAiApiKey: null,
      settings: settings({
        lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
        lmstudioModelId: "local-chat",
        modelContextWindow: 8192,
        modelId: "local-chat",
      }),
    });

    expect(resolution.providerKind).toBe("lmstudio");
    expect(resolution.modelId).toBe("local-chat");
    expect(resolution.contextWindow).toBe(8192);
    expect(resolution.isChatCompletionsPath).toBe(true);
    expect(resolution.model).toBeTruthy();
  });

  it("resolves a selected custom provider to its remote model", () => {
    const resolution = resolveChatProvider({
      envOpenAiApiKey: null,
      settings: settings({
        customProviders: [
          {
            id: "local-provider",
            displayName: "Local Provider",
            baseUrl: "http://127.0.0.1:8080/v1",
            apiKey: "provider-key",
          },
        ],
        modelId: "custom:local-provider:remote-chat",
      }),
    });

    expect(resolution.providerKind).toBe("custom");
    expect(resolution.configuredModelId).toBe("custom:local-provider:remote-chat");
    expect(resolution.modelId).toBe("remote-chat");
    expect(resolution.isChatCompletionsPath).toBe(true);
    expect(resolution.model).toBeTruthy();
  });

  it("rejects OpenAI selection without an API key", () => {
    vi.stubEnv("OPENAI_API_KEY", "");

    expect(() =>
      resolveChatProvider({
        envOpenAiApiKey: null,
        settings: settings({ modelId: "gpt-5.4-mini", openAiApiKey: null }),
      }),
    ).toThrow(ChatProviderResolutionError);
  });
});

function settings(
  overrides: Partial<ResolvedUserSettings> = {},
): ResolvedUserSettings {
  return {
    userId: "provider-user",
    modelId: "gpt-5.4-mini",
    modelContextWindow: null,
    openAiApiKey: null,
    lmstudioBaseUrl: null,
    lmstudioModelId: null,
    customProviders: [],
    ...overrides,
  };
}
