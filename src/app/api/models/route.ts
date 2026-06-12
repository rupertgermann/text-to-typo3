import { type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-route";
import {
  listAvailableModelsForUser,
  streamAvailableModelsForUser,
} from "@/lib/model-service";

export const GET = withAuth(async (request: NextRequest, auth) => {
  const lmstudioBaseUrl = request.nextUrl.searchParams.get("lmstudioBaseUrl");
  const shouldStream = request.nextUrl.searchParams.get("stream") === "1";

  if (shouldStream) {
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const event of streamAvailableModelsForUser(auth.user.id, {
              lmstudioBaseUrlOverride: lmstudioBaseUrl ?? undefined,
            })) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify(event)}\n`),
              );
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      }),
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/x-ndjson; charset=utf-8",
        },
      },
    );
  }

  const catalog = await listAvailableModelsForUser(auth.user.id, {
    lmstudioBaseUrlOverride: lmstudioBaseUrl ?? undefined,
  });

  return Response.json(catalog);
});
