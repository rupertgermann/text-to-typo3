import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getEnv } from "@/lib/env";
import {
  DEFAULT_CHAT_MODEL_ID,
  getModelContextWindowHint,
  type ModelProvider,
} from "@/lib/models";
import type {
  ResolvedCustomProvider,
  ResolvedUserSettings,
} from "@/lib/user-settings";

export class ChatProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatProviderResolutionError";
  }
}

export interface ChatProviderResolution {
  configuredModelId: string;
  contextWindow: number | null;
  isChatCompletionsPath: boolean;
  model: LanguageModel;
  modelId: string;
  provider: ReturnType<typeof createOpenAI>;
  providerKind: ModelProvider;
  supportsBuiltInMcpTool: boolean;
}

export function parseCustomModelId(
  modelId: string,
): { providerId: string; remoteModelId: string } | null {
  const match = /^custom:([^:]+):(.+)$/.exec(modelId);
  if (!match) {
    return null;
  }

  return {
    providerId: match[1],
    remoteModelId: match[2],
  };
}

export function resolveCustomProviderSelection(
  modelId: string,
  providers: ResolvedCustomProvider[],
): { provider: ResolvedCustomProvider; remoteModelId: string } | null {
  const parsed = parseCustomModelId(modelId);
  if (!parsed) {
    return null;
  }

  const provider = providers.find((entry) => entry.id === parsed.providerId);
  return provider ? { provider, remoteModelId: parsed.remoteModelId } : null;
}

export function supportsBuiltInMcpTool(modelId: string): boolean {
  return modelId.trim().toLowerCase() === "gpt-5.4-nano";
}

export function resolveChatProvider({
  envOpenAiApiKey = getEnv().OPENAI_API_KEY,
  settings,
}: {
  envOpenAiApiKey?: string | null;
  settings: ResolvedUserSettings;
}): ChatProviderResolution {
  const configuredModelId = settings.modelId || DEFAULT_CHAT_MODEL_ID;
  const parsedCustomModel = parseCustomModelId(configuredModelId);
  const selectedCustomProvider = resolveCustomProviderSelection(
    configuredModelId,
    settings.customProviders,
  );

  if (parsedCustomModel && !selectedCustomProvider) {
    throw new ChatProviderResolutionError(
      "The selected custom provider is no longer configured.",
    );
  }

  const useCustomProvider = Boolean(selectedCustomProvider);
  const useLmStudio =
    !useCustomProvider &&
    Boolean(settings.lmstudioBaseUrl) &&
    configuredModelId === settings.lmstudioModelId;
  const modelId = selectedCustomProvider?.remoteModelId ?? configuredModelId;
  const openAiApiKey =
    settings.openAiApiKey || envOpenAiApiKey || process.env.OPENAI_API_KEY;

  if (!useLmStudio && !useCustomProvider && !openAiApiKey) {
    throw new ChatProviderResolutionError(
      "Missing OpenAI API key. Add one in settings or .env.local.",
    );
  }

  const provider = createOpenAI({
    apiKey: useCustomProvider
      ? selectedCustomProvider?.provider.apiKey || "custom-provider"
      : useLmStudio
        ? "lm-studio"
        : openAiApiKey,
    baseURL: useCustomProvider
      ? selectedCustomProvider?.provider.baseUrl
      : useLmStudio
        ? settings.lmstudioBaseUrl || undefined
        : undefined,
  });
  const isChatCompletionsPath = useLmStudio || useCustomProvider;
  const model = isChatCompletionsPath
    ? provider.chat(modelId)
    : provider.responses(modelId);

  return {
    configuredModelId,
    contextWindow:
      settings.modelContextWindow ?? getModelContextWindowHint(modelId),
    isChatCompletionsPath,
    model,
    modelId,
    provider,
    providerKind: useCustomProvider
      ? "custom"
      : useLmStudio
        ? "lmstudio"
        : "openai",
    supportsBuiltInMcpTool: supportsBuiltInMcpTool(modelId),
  };
}
