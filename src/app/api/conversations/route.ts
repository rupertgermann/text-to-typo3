import { type NextRequest } from "next/server";
import { withAuth } from "@/lib/api-route";
import {
  createConversationForUser,
  listConversationsForUser,
} from "@/lib/conversations";

export const GET = withAuth(async (request: NextRequest, auth) => {
  const query = request.nextUrl.searchParams.get("q") ?? undefined;
  const userConversations = await listConversationsForUser(auth.user.id, query);

  return Response.json(userConversations);
});

export const POST = withAuth(async (request: NextRequest, auth) => {
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
});
