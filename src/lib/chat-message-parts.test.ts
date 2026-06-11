import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  deserializeMessageParts,
  prepareMessagesForModelInput,
  serializeMessageParts,
} from "./chat-message-parts";

describe("chat message part serialization", () => {
  it("round-trips persisted UI message parts", () => {
    const parts = [
      { type: "text", text: "Inspect the page tree." },
      { type: "text", text: "Then summarize the branches." },
    ] satisfies UIMessage["parts"];

    expect(deserializeMessageParts(serializeMessageParts(parts))).toEqual(parts);
  });

  it("returns null for empty or invalid persisted parts", () => {
    expect(deserializeMessageParts(null)).toBeNull();
    expect(deserializeMessageParts("")).toBeNull();
    expect(deserializeMessageParts("{not json")).toBeNull();
  });

  it("strips replay-unsafe OpenAI response item ids from persisted parts", () => {
    const parts = [
      {
        type: "text",
        text: "Done.",
        providerMetadata: {
          openai: {
            itemId: "msg_duplicate",
            phase: "final_answer",
          },
        },
      },
      {
        type: "tool-WriteTable",
        toolCallId: "call-create-news",
        state: "output-available",
        input: { table: "tx_news_domain_model_news" },
        output: { uid: 123 },
        callProviderMetadata: {
          openai: {
            itemId: "fc_duplicate",
          },
        },
        resultProviderMetadata: {
          azure: {
            itemId: "result_duplicate",
            responseId: "resp_duplicate",
          },
        },
      },
    ] satisfies UIMessage["parts"];

    const persisted = serializeMessageParts(parts);

    expect(persisted).not.toContain("msg_duplicate");
    expect(persisted).not.toContain("fc_duplicate");
    expect(persisted).not.toContain("result_duplicate");
    expect(persisted).not.toContain("resp_duplicate");
    expect(deserializeMessageParts(persisted)).toEqual([
      {
        type: "text",
        text: "Done.",
        providerMetadata: {
          openai: {
            phase: "final_answer",
          },
        },
      },
      {
        type: "tool-WriteTable",
        toolCallId: "call-create-news",
        state: "output-available",
        input: { table: "tx_news_domain_model_news" },
        output: { uid: 123 },
      },
    ]);
  });

  it("removes stale duplicate tool calls before model conversion", () => {
    const messages = [
      {
        id: "assistant-approval",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-WriteTable",
            toolCallId: "call-create-news",
            state: "approval-responded",
            input: { table: "tx_news_domain_model_news" },
            approval: {
              id: "approval-create-news",
              approved: true,
            },
            callProviderMetadata: {
              openai: {
                itemId: "fc_duplicate",
              },
            },
          },
        ],
      },
      {
        id: "assistant-final",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-WriteTable",
            toolCallId: "call-create-news",
            state: "output-available",
            input: { table: "tx_news_domain_model_news" },
            output: { uid: 123 },
            approval: {
              id: "approval-create-news",
              approved: true,
            },
            callProviderMetadata: {
              openai: {
                itemId: "fc_duplicate",
              },
            },
          },
          { type: "text", text: "Created the news record." },
        ],
      },
    ] satisfies UIMessage[];

    expect(prepareMessagesForModelInput(messages)).toEqual([
      {
        id: "assistant-final",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-WriteTable",
            toolCallId: "call-create-news",
            state: "output-available",
            input: { table: "tx_news_domain_model_news" },
            output: { uid: 123 },
            approval: {
              id: "approval-create-news",
              approved: true,
            },
          },
          { type: "text", text: "Created the news record." },
        ],
      },
    ]);
  });
});
