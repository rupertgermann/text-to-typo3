import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getPublicUserSettings,
  upsertUserSettings,
} from "@/lib/user-settings";

type SettingsBody = {
  modelId?: unknown;
  openaiApiKey?: unknown;
  lmstudioBaseUrl?: unknown;
  lmstudioModelId?: unknown;
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

  const updated = await upsertUserSettings(auth.user.id, {
    modelId: asNullableString(body.modelId),
    openaiApiKey: asNullableString(body.openaiApiKey),
    lmstudioBaseUrl: asNullableString(body.lmstudioBaseUrl),
    lmstudioModelId: asNullableString(body.lmstudioModelId),
  });

  return Response.json(updated);
}
