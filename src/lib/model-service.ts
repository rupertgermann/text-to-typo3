import { listLmStudioModels, listOpenAIModels, type UserModelCatalog } from "@/lib/models";
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

  return {
    models: [...openAIModels, ...lmStudioModels],
    selectedModelId: settings.modelId,
    lmstudioBaseUrl,
    hasOpenAIKey: Boolean(settings.openAiApiKey),
  };
}
