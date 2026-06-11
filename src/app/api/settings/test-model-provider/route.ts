import { getAuthenticatedUser } from "@/lib/auth";
import { runModelProviderConnectionTest } from "@/lib/connection-tests";
import { getResolvedUserSettings } from "@/lib/user-settings";

type Body = {
  apiKey?: unknown;
  baseUrl?: unknown;
  provider?: unknown;
};

export async function POST(request: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const settings = await getResolvedUserSettings(auth.user.id);
  const provider = body.provider === "openai" ? "openai" : "lmstudio";
  const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim()
    ? body.baseUrl.trim()
    : provider === "openai"
      ? "https://api.openai.com/v1"
      : settings.lmstudioBaseUrl;
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
    ? body.apiKey.trim()
    : provider === "openai"
      ? settings.openAiApiKey
      : null;

  if (!baseUrl) {
    return Response.json({
      ok: false,
      error: {
        code: "bad_url",
        message: "The provider URL is not configured.",
      },
    });
  }

  return Response.json(
    await runModelProviderConnectionTest({ apiKey, baseUrl }),
  );
}
