import {
  fetchOpenAICompatibleModels,
  fetchOpenAIModels,
  getModelCatalogTimeoutMs,
  type AvailableModel,
  type ModelProvider,
  type ProviderCatalog,
  type UserModelCatalog,
} from "@/lib/models";
import { getResolvedUserSettings } from "@/lib/user-settings";

type ProviderSource = {
  providerId: string;
  providerName: string;
  provider: ModelProvider;
  fetchModels: (signal: AbortSignal) => Promise<AvailableModel[]>;
};

export async function listAvailableModelsForUser(
  userId: string,
  options?: {
    lmstudioBaseUrlOverride?: string | null;
  },
): Promise<UserModelCatalog> {
  const settings = await getResolvedUserSettings(userId);
  const lmstudioBaseUrl =
    options?.lmstudioBaseUrlOverride ?? settings.lmstudioBaseUrl;
  const timeoutMs = getModelCatalogTimeoutMs();

  const sources: ProviderSource[] = [];

  if (settings.openAiApiKey) {
    const apiKey = settings.openAiApiKey;
    sources.push({
      providerId: "openai",
      providerName: "OpenAI",
      provider: "openai",
      fetchModels: (signal) => fetchOpenAIModels(apiKey, signal),
    });
  }

  if (lmstudioBaseUrl) {
    sources.push({
      providerId: "lmstudio",
      providerName: "LM Studio",
      provider: "lmstudio",
      fetchModels: (signal) =>
        fetchOpenAICompatibleModels(
          {
            baseUrl: lmstudioBaseUrl,
            displayName: "LM Studio",
            id: "lmstudio",
            provider: "lmstudio",
          },
          signal,
        ),
    });
  }

  for (const customProvider of settings.customProviders) {
    sources.push({
      providerId: customProvider.id,
      providerName: customProvider.displayName,
      provider: "custom",
      fetchModels: (signal) =>
        fetchOpenAICompatibleModels(
          {
            apiKey: customProvider.apiKey,
            baseUrl: customProvider.baseUrl,
            displayName: customProvider.displayName,
            id: customProvider.id,
            provider: "custom",
          },
          signal,
        ),
    });
  }

  const providers: ProviderCatalog[] = await Promise.all(
    sources.map(async ({ fetchModels, ...descriptor }) => {
      try {
        return {
          ...descriptor,
          status: "ok" as const,
          models: await fetchModels(AbortSignal.timeout(timeoutMs)),
        };
      } catch {
        return { ...descriptor, status: "unavailable" as const, models: [] };
      }
    }),
  );

  const modelsOfKind = (kind: ModelProvider) =>
    providers
      .filter((provider) => provider.provider === kind)
      .flatMap((provider) => provider.models);

  return {
    models: [
      ...modelsOfKind("openai"),
      ...modelsOfKind("lmstudio"),
      ...modelsOfKind("custom").sort((a, b) => a.name.localeCompare(b.name)),
    ],
    providers,
    selectedModelId: settings.modelId,
    lmstudioBaseUrl,
    hasOpenAIKey: Boolean(settings.openAiApiKey),
    customProviders: settings.customProviders.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      hasApiKey: Boolean(provider.apiKey),
    })),
  };
}
