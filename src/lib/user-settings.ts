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
}

export interface PublicUserSettings {
  userId: string;
  modelId: string | null;
  hasOpenAIKey: boolean;
  lmstudioBaseUrl: string | null;
  lmstudioModelId: string | null;
}

export interface ResolvedUserSettings {
  userId: string;
  modelId: string | null;
  openAiApiKey: string | null;
  lmstudioBaseUrl: string | null;
  lmstudioModelId: string | null;
}

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

export async function getUserSettingsRow(userId: string) {
  return db.query.userSettings.findFirst({
    where: eq(userSettings.user_id, userId),
  });
}

export async function getPublicUserSettings(
  userId: string,
): Promise<PublicUserSettings> {
  const settings = await getUserSettingsRow(userId);

  return {
    userId,
    modelId: settings?.model_id ?? null,
    hasOpenAIKey: Boolean(settings?.openai_api_key),
    lmstudioBaseUrl: settings?.lmstudio_base_url ?? null,
    lmstudioModelId: settings?.lmstudio_model_id ?? null,
  };
}

export async function getResolvedUserSettings(
  userId: string,
): Promise<ResolvedUserSettings> {
  const settings = await getUserSettingsRow(userId);
  const env = getEnv();

  return {
    userId,
    modelId: settings?.model_id ?? null,
    openAiApiKey: settings?.openai_api_key
      ? decrypt(settings.openai_api_key)
      : env.OPENAI_API_KEY || null,
    lmstudioBaseUrl: settings?.lmstudio_base_url ?? null,
    lmstudioModelId: settings?.lmstudio_model_id ?? null,
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
      },
    });

  return {
    userId,
    modelId: nextModelId,
    hasOpenAIKey: Boolean(nextOpenAiApiKey),
    lmstudioBaseUrl: nextLmStudioBaseUrl ?? null,
    lmstudioModelId: nextLmStudioModelId,
  };
}
