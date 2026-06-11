import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";

export interface UserSettingsInput {
  modelId?: string | null;
  openaiApiKey?: string | null;
  lmstudioBaseUrl?: string | null;
  lmstudioModelId?: string | null;
  customProviders?: CustomProviderInput[] | null;
}

export interface CustomProviderInput {
  id?: string | null;
  displayName?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface PublicCustomProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
}

export interface ResolvedCustomProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
}

export interface PublicUserSettings {
  userId: string;
  modelId: string | null;
  hasOpenAIKey: boolean;
  lmstudioBaseUrl: string | null;
  lmstudioModelId: string | null;
  customProviders: PublicCustomProvider[];
}

export interface ResolvedUserSettings {
  userId: string;
  modelId: string | null;
  openAiApiKey: string | null;
  lmstudioBaseUrl: string | null;
  lmstudioModelId: string | null;
  customProviders: ResolvedCustomProvider[];
}

export class UserSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserSettingsValidationError";
  }
}

type StoredCustomProvider = {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | null;
};

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBaseUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  return normalized.replace(/\/+$/, "");
}

function normalizeHttpBaseUrl(value: string | null | undefined): string {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    throw new UserSettingsValidationError("Custom provider base URL is required.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new UserSettingsValidationError("Custom provider base URL is not valid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserSettingsValidationError("Custom provider base URL must use HTTP or HTTPS.");
  }

  return url.toString().replace(/\/+$/, "");
}

function makeProviderId(input: CustomProviderInput): string {
  const explicit = normalizeNullableString(input.id);
  if (explicit) {
    return explicit
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  const displayName = normalizeNullableString(input.displayName);
  if (displayName) {
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (slug) {
      return slug;
    }
  }

  return crypto.randomUUID().replace(/-/g, "");
}

function parseStoredCustomProviders(value: string | null | undefined): StoredCustomProvider[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const provider = entry as Record<string, unknown>;
      const id = typeof provider.id === "string" ? provider.id : null;
      const displayName =
        typeof provider.displayName === "string" ? provider.displayName : null;
      const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : null;
      const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : null;

      if (!id || !displayName || !baseUrl) {
        return [];
      }

      return [{ id, displayName, baseUrl, apiKey }];
    });
  } catch {
    return [];
  }
}

function toPublicCustomProviders(
  providers: StoredCustomProvider[],
): PublicCustomProvider[] {
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    hasApiKey: Boolean(provider.apiKey),
  }));
}

function toResolvedCustomProviders(
  providers: StoredCustomProvider[],
): ResolvedCustomProvider[] {
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ? decrypt(provider.apiKey) : null,
  }));
}

function normalizeCustomProviders(
  input: CustomProviderInput[] | null | undefined,
  existingValue: string | null | undefined,
): StoredCustomProvider[] {
  const existing = parseStoredCustomProviders(existingValue);
  if (input === undefined) {
    return existing;
  }

  if (input === null) {
    return [];
  }

  const existingById = new Map(existing.map((provider) => [provider.id, provider]));
  const normalizedProviders = new Map<string, StoredCustomProvider>();

  for (const entry of input) {
    const id = makeProviderId(entry);
    if (!id) {
      throw new UserSettingsValidationError("Custom provider id is not valid.");
    }

    const displayName = normalizeNullableString(entry.displayName);
    if (!displayName) {
      throw new UserSettingsValidationError("Custom provider name is required.");
    }

    const baseUrl = normalizeHttpBaseUrl(entry.baseUrl);
    const normalizedApiKey =
      entry.apiKey === undefined
        ? undefined
        : normalizeNullableString(entry.apiKey);
    const nextApiKey =
      normalizedApiKey === undefined
        ? existingById.get(id)?.apiKey ?? null
        : normalizedApiKey
          ? encrypt(normalizedApiKey)
          : null;

    normalizedProviders.set(id, {
      id,
      displayName,
      baseUrl,
      apiKey: nextApiKey,
    });
  }

  return [...normalizedProviders.values()];
}

export async function getUserSettingsRow(userId: string) {
  return db.query.userSettings.findFirst({
    where: eq(userSettings.user_id, userId),
  });
}

export async function getPublicUserSettings(
  userId: string,
): Promise<PublicUserSettings> {
  const settings = await getUserSettingsRow(userId);
  const customProviders = parseStoredCustomProviders(settings?.custom_providers);

  return {
    userId,
    modelId: settings?.model_id ?? null,
    hasOpenAIKey: Boolean(settings?.openai_api_key),
    lmstudioBaseUrl: settings?.lmstudio_base_url ?? null,
    lmstudioModelId: settings?.lmstudio_model_id ?? null,
    customProviders: toPublicCustomProviders(customProviders),
  };
}

export async function getResolvedUserSettings(
  userId: string,
): Promise<ResolvedUserSettings> {
  const settings = await getUserSettingsRow(userId);
  const env = getEnv();
  const customProviders = parseStoredCustomProviders(settings?.custom_providers);

  return {
    userId,
    modelId: settings?.model_id ?? null,
    openAiApiKey: settings?.openai_api_key
      ? decrypt(settings.openai_api_key)
      : env.OPENAI_API_KEY || null,
    lmstudioBaseUrl: settings?.lmstudio_base_url ?? null,
    lmstudioModelId: settings?.lmstudio_model_id ?? null,
    customProviders: toResolvedCustomProviders(customProviders),
  };
}

export async function upsertUserSettings(
  userId: string,
  input: UserSettingsInput,
): Promise<PublicUserSettings> {
  const existing = await getUserSettingsRow(userId);
  const normalizedOpenAiApiKey =
    input.openaiApiKey === undefined
      ? undefined
      : normalizeNullableString(input.openaiApiKey);

  const nextModelId =
    input.modelId === undefined
      ? existing?.model_id ?? null
      : normalizeNullableString(input.modelId);
  const nextLmStudioBaseUrl =
    input.lmstudioBaseUrl === undefined
      ? existing?.lmstudio_base_url ?? null
      : normalizeBaseUrl(input.lmstudioBaseUrl);
  const nextLmStudioModelId =
    input.lmstudioModelId === undefined
      ? existing?.lmstudio_model_id ?? null
      : normalizeNullableString(input.lmstudioModelId);
  const nextCustomProviders = normalizeCustomProviders(
    input.customProviders,
    existing?.custom_providers,
  );
  const nextOpenAiApiKey =
    normalizedOpenAiApiKey === undefined
      ? existing?.openai_api_key ?? null
      : normalizedOpenAiApiKey
        ? encrypt(normalizedOpenAiApiKey)
        : null;

  const nextRow = {
    user_id: userId,
    model_id: nextModelId,
    openai_api_key: nextOpenAiApiKey,
    lmstudio_base_url: nextLmStudioBaseUrl,
    lmstudio_model_id: nextLmStudioModelId,
    custom_providers: JSON.stringify(nextCustomProviders),
  };

  await db
    .insert(userSettings)
    .values(nextRow)
    .onConflictDoUpdate({
      target: userSettings.user_id,
      set: {
        model_id: nextRow.model_id,
        openai_api_key: nextRow.openai_api_key,
        lmstudio_base_url: nextRow.lmstudio_base_url,
        lmstudio_model_id: nextRow.lmstudio_model_id,
        custom_providers: nextRow.custom_providers,
      },
    });

  return {
    userId,
    modelId: nextModelId,
    hasOpenAIKey: Boolean(nextOpenAiApiKey),
    lmstudioBaseUrl: nextLmStudioBaseUrl ?? null,
    lmstudioModelId: nextLmStudioModelId,
    customProviders: toPublicCustomProviders(nextCustomProviders),
  };
}
