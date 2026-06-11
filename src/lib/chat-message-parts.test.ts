import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  deserializeMessageParts,
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
});
