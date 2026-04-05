import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  createConversationForUser,
  listConversationsForUser,
} from "@/lib/conversations";

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q") ?? undefined;
  const userConversations = await listConversationsForUser(auth.user.id, query);

  return Response.json(userConversations);
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { title?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "New Conversation";

  const conversation = await createConversationForUser(auth.user.id, title);

  return Response.json(conversation, { status: 201 });
}
