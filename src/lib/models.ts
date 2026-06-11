import type { PublicCustomProvider, ResolvedCustomProvider } from "@/lib/user-settings";

type OpenAIModelsResponse = {
  data?: Array<{ id?: string }>;
};

type OpenAICompatibleModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    object?: string;
    context_length?: number;
    max_context_length?: number;
  }>;
};

export type ModelProvider = "openai" | "lmstudio" | "custom";

export interface AvailableModel {
  id: string;
  name: string;
  provider: ModelProvider;
  providerId?: string | null;
  providerName?: string | null;
  remoteModelId?: string | null;
  contextWindow: number | null;
  baseUrl?: string | null;
  description?: string | null;
}

export interface UserModelCatalog {
  models: AvailableModel[];
  selectedModelId: string | null;
  lmstudioBaseUrl: string | null;
  hasOpenAIKey: boolean;
  customProviders: PublicCustomProvider[];
}

export const DEFAULT_CHAT_MODEL_ID = "gpt-5.4-mini";

export interface SelectedModelSummary {
  id: string;
  name: string;
  providerName: string | null;
}

const LATEST_OPENAI_MODELS: Array<{
  id: string;
  name: string;
  description: string;
}> = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "A new class of intelligence for coding and professional work.",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "A more affordable model for coding and professional work.",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    description: "Our strongest mini model yet for coding, computer use, and subagents",
  },
];

function normalizeModelId(id: string): string {
  return id.trim();
}

export function getModelContextWindowHint(id: string): number | null {
  const normalized = id.toLowerCase();

  const hints: Array<[RegExp, number]> = [
    [/gpt-5/, 400000],
    [/gpt-4\.1/, 1000000],
    [/gpt-4o/, 128000],
    [/gpt-4/, 128000],
    [/o1/, 200000],
    [/o3/, 200000],
    [/o4/, 200000],
  ];

  for (const [pattern, contextWindow] of hints) {
    if (pattern.test(normalized)) {
      return contextWindow;
    }
  }

  return null;
}

function buildDisplayName(id: string): string {
  return id.replaceAll("-", " ");
}

export function getSelectedModelSummary({
  customProviders = [],
  lmstudioModelId,
  modelId,
}: {
  customProviders?: Pick<PublicCustomProvider, "displayName" | "id">[];
  lmstudioModelId?: string | null;
  modelId?: string | null;
}): SelectedModelSummary {
  const id = normalizeModelId(modelId || DEFAULT_CHAT_MODEL_ID);
  const openAIModel = LATEST_OPENAI_MODELS.find((model) => model.id === id);

  if (openAIModel) {
    return {
      id,
      name: openAIModel.name,
      providerName: "OpenAI",
    };
  }

  const customModelMatch = /^custom:([^:]+):(.+)$/.exec(id);
  if (customModelMatch) {
    const [, providerId, remoteModelId] = customModelMatch;
    const provider = customProviders.find((entry) => entry.id === providerId);

    return {
      id,
      name: buildDisplayName(remoteModelId),
      providerName: provider?.displayName ?? "Custom",
    };
  }

  return {
    id,
    name: buildDisplayName(id),
    providerName: lmstudioModelId === id ? "LM Studio" : null,
  };
}

type LmStudioModelCandidate = {
  id: string;
  name: string;
  provider: "lmstudio" | "custom";
  providerId: string;
  providerName: string;
  remoteModelId: string;
  contextWindow: number | null;
  baseUrl: string;
} | null;

type OpenAICompatibleProviderConfig = {
  apiKey?: string | null;
  baseUrl: string;
  displayName: string;
  id: string;
  provider: "lmstudio" | "custom";
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to fetch models from ${url}`);
  }
  return response.json() as Promise<T>;
}

export async function listOpenAIModels(
  apiKey: string,
): Promise<AvailableModel[]> {
  if (!apiKey) {
    return [];
  }

  try {
    const json = await fetchJson<OpenAIModelsResponse>("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const rawModels = Array.isArray(json?.data)
      ? json.data
      : [];

    const availableModelIds = new Set(
      rawModels
        .map((entry) => entry.id?.trim())
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => normalizeModelId(id).toLowerCase()),
    );

    return LATEST_OPENAI_MODELS
      .filter((model) => availableModelIds.has(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: "openai" as const,
        providerId: "openai",
        providerName: "OpenAI",
        remoteModelId: model.id,
        contextWindow: getModelContextWindowHint(model.id),
        description: model.description,
      }));
  } catch {
    return [];
  }
}

export async function listLmStudioModels(
  baseUrl: string,
): Promise<AvailableModel[]> {
  if (!baseUrl) {
    return [];
  }

  return listOpenAICompatibleModels({
    baseUrl,
    displayName: "LM Studio",
    id: "lmstudio",
    provider: "lmstudio",
  });
}

export async function listCustomProviderModels(
  providers: ResolvedCustomProvider[],
): Promise<AvailableModel[]> {
  const providerModels = await Promise.all(
    providers.map((provider) =>
      listOpenAICompatibleModels({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        displayName: provider.displayName,
        id: provider.id,
        provider: "custom",
      }),
    ),
  );

  return providerModels.flat().sort((a, b) => a.name.localeCompare(b.name));
}

export async function listOpenAICompatibleModels(
  providerConfig: OpenAICompatibleProviderConfig,
): Promise<AvailableModel[]> {
  const { apiKey, baseUrl, displayName, id: providerId, provider } = providerConfig;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  try {
    const json = await fetchJson<OpenAICompatibleModelsResponse>(
      `${normalizedBaseUrl}/models`,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      },
    );
    const rawModels = Array.isArray(json?.data) ? json.data : [];

    return rawModels
      .map<LmStudioModelCandidate>((entry) => {
        const id = entry.id?.trim();
        if (!id) {
          return null;
        }
        const remoteModelId = normalizeModelId(id);

        return {
          id:
            provider === "custom"
              ? `custom:${providerId}:${remoteModelId}`
              : remoteModelId,
          name: entry.name?.trim() || buildDisplayName(id),
          provider,
          providerId,
          providerName: displayName,
          remoteModelId,
          contextWindow:
            entry.context_length ??
            entry.max_context_length ??
            getModelContextWindowHint(id),
          baseUrl: normalizedBaseUrl,
        };
      })
      .filter((model): model is Exclude<LmStudioModelCandidate, null> => model !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getModelContextWindowLabel(
  contextWindow: number | null,
): string {
  if (!contextWindow) {
    return "Context window unknown";
  }

  return `Context window ${contextWindow.toLocaleString("en-US")} tokens`;
}

export function getModelContextWindowShortLabel(
  contextWindow: number | null,
): string {
  if (!contextWindow) {
    return "Context unknown";
  }

  if (contextWindow >= 1_000_000) {
    return `${Math.round(contextWindow / 1_000_000)}M ctx`;
  }

  if (contextWindow >= 1_000) {
    return `${Math.round(contextWindow / 1_000)}k ctx`;
  }

  return `${contextWindow} ctx`;
}
