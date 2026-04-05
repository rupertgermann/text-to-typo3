type OpenAIModelsResponse = {
  data?: Array<{ id?: string }>;
};

type LmStudioModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    object?: string;
    context_length?: number;
    max_context_length?: number;
  }>;
};

export type ModelProvider = "openai" | "lmstudio";

export interface AvailableModel {
  id: string;
  name: string;
  provider: ModelProvider;
  contextWindow: number | null;
  baseUrl?: string | null;
  description?: string | null;
}

export interface UserModelCatalog {
  models: AvailableModel[];
  selectedModelId: string | null;
  lmstudioBaseUrl: string | null;
  hasOpenAIKey: boolean;
}

function normalizeModelId(id: string): string {
  return id.trim();
}

function isAllowedOpenAIModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return /^gpt-5\.4(?:-(?:mini|nano|nao))?$/.test(normalized);
}

function estimateContextWindow(id: string): number | null {
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

type LmStudioModelCandidate = {
  id: string;
  name: string;
  provider: "lmstudio";
  contextWindow: number | null;
  baseUrl: string;
} | null;

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

    return rawModels
      .map((entry) => entry.id?.trim())
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id) => isAllowedOpenAIModelId(id))
      .map((id) => ({
        id: normalizeModelId(id),
        name: buildDisplayName(id),
        provider: "openai" as const,
        contextWindow: estimateContextWindow(id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  try {
    const json = await fetchJson<LmStudioModelsResponse>(`${normalizedBaseUrl}/models`);
    const rawModels = Array.isArray(json?.data) ? json.data : [];

    return rawModels
      .map<LmStudioModelCandidate>((entry) => {
        const id = entry.id?.trim();
        if (!id) {
          return null;
        }

        return {
          id,
          name: entry.name?.trim() || buildDisplayName(id),
          provider: "lmstudio" as const,
          contextWindow:
            entry.context_length ??
            entry.max_context_length ??
            estimateContextWindow(id),
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

  return `Context window ${contextWindow.toLocaleString()} tokens`;
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
