import { getAuthenticatedUser } from "@/lib/auth";
import { runMcpConnectionTest } from "@/lib/connection-tests";

export async function POST() {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json(await runMcpConnectionTest(auth.accessToken));
}
