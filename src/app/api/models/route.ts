import { type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-route";
import { listAvailableModelsForUser } from "@/lib/model-service";

export const GET = withAuth(async (request: NextRequest, auth) => {
  const lmstudioBaseUrl = request.nextUrl.searchParams.get("lmstudioBaseUrl");
  const catalog = await listAvailableModelsForUser(auth.user.id, {
    lmstudioBaseUrlOverride: lmstudioBaseUrl ?? undefined,
  });

  return Response.json(catalog);
});
