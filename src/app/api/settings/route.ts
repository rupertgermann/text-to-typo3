import { type NextRequest } from "next/server";
import { badRequest, withAuth } from "@/lib/api-route";
import {
  type CustomProviderInput,
  getPublicUserSettings,
  upsertUserSettings,
  UserSettingsValidationError,
} from "@/lib/user-settings";
import { listAvailableModelsForUser } from "@/lib/model-service";
import { getOpenAIModelContextWindowHint } from "@/lib/models";

type SettingsBody = {
  modelId?: unknown;
  modelContextWindow?: unknown;
  openaiApiKey?: unknown;
  lmstudioBaseUrl?: unknown;
  lmstudioModelId?: unknown;
  customProviders?: unknown;
};

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function asNullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "number") {
    return undefined;
  }

  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asCustomProviders(
  value: unknown,
): CustomProviderInput[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Array.isArray(value)) {
    throw new UserSettingsValidationError("Custom providers must be an array.");
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new UserSettingsValidationError("Custom providers must be objects.");
    }

    const provider = entry as Record<string, unknown>;
    return {
      id: asNullableString(provider.id),
      displayName: asNullableString(provider.displayName),
      baseUrl: asNullableString(provider.baseUrl),
      apiKey: asNullableString(provider.apiKey),
    };
  });
}

export const GET = withAuth(async (_request: NextRequest, auth) => {
  const settings = await getPublicUserSettings(auth.user.id);
  return Response.json(settings);
});

export const PATCH = withAuth(async (request: NextRequest, auth) => {
  let body: SettingsBody;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  let updated;
  try {
    updated = await upsertUserSettings(auth.user.id, {
      modelId: asNullableString(body.modelId),
      modelContextWindow: asNullablePositiveInteger(body.modelContextWindow),
      openaiApiKey: asNullableString(body.openaiApiKey),
      lmstudioBaseUrl: asNullableString(body.lmstudioBaseUrl),
      lmstudioModelId: asNullableString(body.lmstudioModelId),
      customProviders: asCustomProviders(body.customProviders),
    });
    const selectedModelId = updated.modelId;
    if (
      selectedModelId &&
      (body.modelId !== undefined ||
        body.lmstudioBaseUrl !== undefined ||
        body.lmstudioModelId !== undefined ||
        body.customProviders !== undefined)
    ) {
      const staticHint = getOpenAIModelContextWindowHint(selectedModelId);
      const modelContextWindow =
        staticHint ??
        (await listAvailableModelsForUser(auth.user.id)).models.find(
          (model) => model.id === selectedModelId,
        )?.contextWindow ??
        null;

      updated = await upsertUserSettings(auth.user.id, {
        modelContextWindow,
      });
    } else if (!selectedModelId && body.modelId !== undefined) {
      updated = await upsertUserSettings(auth.user.id, {
        modelContextWindow: null,
      });
    }
  } catch (error) {
    if (error instanceof UserSettingsValidationError) {
      return badRequest(error.message);
    }

    throw error;
  }

  return Response.json(updated);
});
