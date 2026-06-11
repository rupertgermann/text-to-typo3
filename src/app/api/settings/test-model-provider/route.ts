import { getAuthenticatedUser } from "@/lib/auth";
import { runModelProviderConnectionTest } from "@/lib/connection-tests";
import { getResolvedUserSettings } from "@/lib/user-settings";

type Body = {
  apiKey?: unknown;
  baseUrl?: unknown;
  customProviderId?: unknown;
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
  const provider =
    body.provider === "openai"
      ? "openai"
      : body.provider === "custom"
        ? "custom"
        : "lmstudio";
  const customProviderId = typeof body.customProviderId === "string"
    ? body.customProviderId.trim()
    : null;
  const savedCustomProvider = provider === "custom" && customProviderId
    ? settings.customProviders.find((entry) => entry.id === customProviderId)
    : null;
  const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim()
    ? body.baseUrl.trim()
    : provider === "openai"
      ? "https://api.openai.com/v1"
      : provider === "custom"
        ? savedCustomProvider?.baseUrl
        : settings.lmstudioBaseUrl;
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
    ? body.apiKey.trim()
    : provider === "openai"
      ? settings.openAiApiKey
      : provider === "custom"
        ? savedCustomProvider?.apiKey
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
