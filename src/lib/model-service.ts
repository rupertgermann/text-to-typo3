import {
  listCustomProviderModels,
  listLmStudioModels,
  listOpenAIModels,
  type UserModelCatalog,
} from "@/lib/models";
import { getResolvedUserSettings } from "@/lib/user-settings";

export async function listAvailableModelsForUser(
  userId: string,
  options?: {
    lmstudioBaseUrlOverride?: string | null;
  },
): Promise<UserModelCatalog> {
  const settings = await getResolvedUserSettings(userId);
  const lmstudioBaseUrl =
    options?.lmstudioBaseUrlOverride ?? settings.lmstudioBaseUrl;

  const openAIModels = settings.openAiApiKey
    ? await listOpenAIModels(settings.openAiApiKey)
    : [];
  const lmStudioModels = lmstudioBaseUrl
    ? await listLmStudioModels(lmstudioBaseUrl)
    : [];
  const customModels = await listCustomProviderModels(settings.customProviders);

  return {
    models: [...openAIModels, ...lmStudioModels, ...customModels],
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
