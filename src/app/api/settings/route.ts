import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  type CustomProviderInput,
  getPublicUserSettings,
  upsertUserSettings,
  UserSettingsValidationError,
} from "@/lib/user-settings";

type SettingsBody = {
  modelId?: unknown;
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

export async function GET() {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getPublicUserSettings(auth.user.id);
  return Response.json(settings);
}

export async function PATCH(request: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SettingsBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  let updated;
  try {
    updated = await upsertUserSettings(auth.user.id, {
      modelId: asNullableString(body.modelId),
      openaiApiKey: asNullableString(body.openaiApiKey),
      lmstudioBaseUrl: asNullableString(body.lmstudioBaseUrl),
      lmstudioModelId: asNullableString(body.lmstudioModelId),
      customProviders: asCustomProviders(body.customProviders),
    });
  } catch (error) {
    if (error instanceof UserSettingsValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    throw error;
  }

  return Response.json(updated);
}
