import { type NextRequest } from "next/server";
import { type UIMessage } from "ai";
import { badRequest, withAuth } from "@/lib/api-route";
import { streamChatExchange } from "@/lib/chat-exchange";
import { type ChatTurnTrigger } from "@/lib/chat-turn-resolution";

export const POST = withAuth(async (request: NextRequest, auth) => {
  let body: {
    messages?: unknown;
    conversationId?: unknown;
    messageId?: unknown;
    trigger?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body");
  }

  const { messages: incomingMessages, conversationId } = body;
  const messageId =
    typeof body.messageId === "string" ? body.messageId : undefined;
  const trigger: ChatTurnTrigger =
    body.trigger === "regenerate-message"
      ? "regenerate-message"
      : "submit-message";

  if (!conversationId || typeof conversationId !== "string") {
    return badRequest("conversationId is required");
  }

  if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
    return badRequest("messages array is required");
  }

  return streamChatExchange({
    auth,
    conversationId,
    messageId,
    trigger,
    uiMessages: incomingMessages as UIMessage[],
  });
});
