import { type NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  deleteConversationForUser,
  getConversationWithMessagesForUser,
  updateConversationForUser,
} from "@/lib/conversations";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const conversation = await getConversationWithMessagesForUser(
    auth.user.id,
    id,
  );

  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  return Response.json(conversation);
}

export async function PATCH(
  request: NextRequest,
  { params }: RouteContext,
) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { autoApproveWrites?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const hasTitle = body.title !== undefined;
  const hasAutoApproveWrites = body.autoApproveWrites !== undefined;

  if (!hasTitle && !hasAutoApproveWrites) {
    return Response.json(
      { error: "title or autoApproveWrites is required" },
      { status: 400 },
    );
  }

  if (hasTitle && (typeof body.title !== "string" || !body.title.trim())) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  if (hasAutoApproveWrites && typeof body.autoApproveWrites !== "boolean") {
    return Response.json(
      { error: "autoApproveWrites must be a boolean" },
      { status: 400 },
    );
  }

  const updated = await updateConversationForUser(auth.user.id, id, {
    ...(hasTitle ? { title: (body.title as string).trim() } : {}),
    ...(hasAutoApproveWrites
      ? { autoApproveWrites: body.autoApproveWrites as boolean }
      : {}),
  });

  if (!updated) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  return Response.json(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const auth = await getAuthenticatedUser();
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const deleted = await deleteConversationForUser(auth.user.id, id);
  if (!deleted) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
