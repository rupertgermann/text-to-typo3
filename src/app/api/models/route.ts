import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { listAvailableModelsForUser } from "@/lib/model-service";

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lmstudioBaseUrl = request.nextUrl.searchParams.get("lmstudioBaseUrl");
  const catalog = await listAvailableModelsForUser(auth.user.id, {
    lmstudioBaseUrlOverride: lmstudioBaseUrl ?? undefined,
  });

  return Response.json(catalog);
}
