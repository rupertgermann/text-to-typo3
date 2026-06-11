import { withAuth } from "@/lib/api-route";
import { runMcpConnectionTest } from "@/lib/connection-tests";

export const POST = withAuth(async (_request, auth) => {
  return Response.json(await runMcpConnectionTest(auth.accessToken));
});
