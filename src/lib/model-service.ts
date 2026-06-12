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

type ModelCatalogSources = Pick<
  UserModelCatalog,
  "customProviders" | "hasOpenAIKey" | "lmstudioBaseUrl" | "selectedModelId"
> & {
  sources: ProviderSource[];
  timeoutMs: number;
};

export type UserModelCatalogStreamEvent =
  | {
      type: "metadata";
      customProviders: UserModelCatalog["customProviders"];
      hasOpenAIKey: boolean;
      lmstudioBaseUrl: string | null;
      selectedModelId: string | null;
    }
  | { type: "provider"; provider: ProviderCatalog }
  | { type: "done"; catalog: UserModelCatalog };

export async function listAvailableModelsForUser(
  userId: string,
  options?: {
    lmstudioBaseUrlOverride?: string | null;
  },
): Promise<UserModelCatalog> {
  const catalogSources = await getModelCatalogSourcesForUser(userId, options);
  const providers = await Promise.all(
    catalogSources.sources.map((source) =>
      fetchProviderCatalog(source, catalogSources.timeoutMs),
    ),
  );

  return buildUserModelCatalog(catalogSources, providers);
}

export async function* streamAvailableModelsForUser(
  userId: string,
  options?: {
    lmstudioBaseUrlOverride?: string | null;
  },
): AsyncGenerator<UserModelCatalogStreamEvent> {
  const catalogSources = await getModelCatalogSourcesForUser(userId, options);

  yield {
    type: "metadata",
    customProviders: catalogSources.customProviders,
    hasOpenAIKey: catalogSources.hasOpenAIKey,
    lmstudioBaseUrl: catalogSources.lmstudioBaseUrl,
    selectedModelId: catalogSources.selectedModelId,
  };

  const providers: Array<ProviderCatalog | undefined> = new Array(
    catalogSources.sources.length,
  );
  const pending = new Map(
    catalogSources.sources.map((source, index) => [
      index,
      fetchProviderCatalog(source, catalogSources.timeoutMs).then((provider) => ({
        index,
        provider,
      })),
    ]),
  );

  while (pending.size > 0) {
    const { index, provider } = await Promise.race(pending.values());
    pending.delete(index);
    providers[index] = provider;
    yield { type: "provider", provider };
  }

  yield {
    type: "done",
    catalog: buildUserModelCatalog(
      catalogSources,
      providers.filter((provider): provider is ProviderCatalog => Boolean(provider)),
    ),
  };
}

async function getModelCatalogSourcesForUser(
  userId: string,
  options?: {
    lmstudioBaseUrlOverride?: string | null;
  },
): Promise<ModelCatalogSources> {
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

  return {
    sources,
    timeoutMs,
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

async function fetchProviderCatalog(
  { fetchModels, ...descriptor }: ProviderSource,
  timeoutMs: number,
): Promise<ProviderCatalog> {
  try {
    return {
      ...descriptor,
      status: "ok" as const,
      models: await fetchModels(AbortSignal.timeout(timeoutMs)),
    };
  } catch {
    return { ...descriptor, status: "unavailable" as const, models: [] };
  }
}

function buildUserModelCatalog(
  catalogSources: Pick<
    UserModelCatalog,
    "customProviders" | "hasOpenAIKey" | "lmstudioBaseUrl" | "selectedModelId"
  >,
  providers: ProviderCatalog[],
): UserModelCatalog {
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
    selectedModelId: catalogSources.selectedModelId,
    lmstudioBaseUrl: catalogSources.lmstudioBaseUrl,
    hasOpenAIKey: catalogSources.hasOpenAIKey,
    customProviders: catalogSources.customProviders,
  };
}
