import { type NextRequest } from "next/server";
import { badRequest, notFound, withAuth } from "@/lib/api-route";
import {
  deleteConversationForUser,
  getConversationWithMessagesForUser,
  updateConversationForUser,
} from "@/lib/conversations";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withAuth<RouteContext>(async (
  _request: NextRequest,
  auth,
  { params },
) => {
  const { id } = await params;

  const conversation = await getConversationWithMessagesForUser(
    auth.user.id,
    id,
  );

  if (!conversation) {
    return notFound("Conversation not found");
  }

  return Response.json(conversation);
});

export const PATCH = withAuth<RouteContext>(async (
  request: NextRequest,
  auth,
  { params },
) => {
  const { id } = await params;

  let body: { autoApproveWrites?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const hasTitle = body.title !== undefined;
  const hasAutoApproveWrites = body.autoApproveWrites !== undefined;

  if (!hasTitle && !hasAutoApproveWrites) {
    return badRequest("title or autoApproveWrites is required");
  }

  if (hasTitle && (typeof body.title !== "string" || !body.title.trim())) {
    return badRequest("title is required");
  }

  if (hasAutoApproveWrites && typeof body.autoApproveWrites !== "boolean") {
    return badRequest("autoApproveWrites must be a boolean");
  }

  const updated = await updateConversationForUser(auth.user.id, id, {
    ...(hasTitle ? { title: (body.title as string).trim() } : {}),
    ...(hasAutoApproveWrites
      ? { autoApproveWrites: body.autoApproveWrites as boolean }
      : {}),
  });

  if (!updated) {
    return notFound("Conversation not found");
  }

  return Response.json(updated);
});

export const DELETE = withAuth<RouteContext>(async (
  _request: NextRequest,
  auth,
  { params },
) => {
  const { id } = await params;

  const deleted = await deleteConversationForUser(auth.user.id, id);
  if (!deleted) {
    return notFound("Conversation not found");
  }

  return new Response(null, { status: 204 });
});
