import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

describe("retrying user messages", () => {
  it.each([true, false])("preserves an image when retrying with text=%s", async (withText) => {
    const userMessage: UIMessage = {
      id: "user-image",
      role: "user",
      parts: [
        ...(withText ? [{ type: "text" as const, text: "Inspect this screenshot" }] : []),
        { type: "file", mediaType: "image/png", filename: "page.png", url: "data:image/png;base64,aW1hZ2U=" },
      ],
    };
    const sendMessages = vi.fn<ChatTransport<UIMessage>["sendMessages"]>(async () =>
      new ReadableStream({ start(controller) { controller.close(); } }),
    );
    const chat = new Chat({
      messages: [userMessage, { id: "failed-answer", role: "assistant", parts: [] }],
      transport: { sendMessages, reconnectToStream: async () => null },
    });

    await chat.sendMessage({ parts: userMessage.parts, messageId: userMessage.id });

    expect(sendMessages).toHaveBeenCalledOnce();
    expect(sendMessages.mock.calls[0][0].messages).toHaveLength(1);
    expect(sendMessages.mock.calls[0][0].messages[0]).toMatchObject(userMessage);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject(userMessage);
    expect(chat.status).toBe("ready");
  });
});
