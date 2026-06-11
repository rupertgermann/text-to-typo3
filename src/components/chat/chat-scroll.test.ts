import { describe, expect, it } from "vitest";
import {
  getChatAutoScrollBehavior,
  isNearChatBottom,
} from "./chat-scroll";

describe("chat scroll policy", () => {
  it("treats the transcript as pinned while it is close to the bottom", () => {
    expect(
      isNearChatBottom({
        clientHeight: 600,
        scrollHeight: 1_000,
        scrollTop: 320,
      }),
    ).toBe(true);
  });

  it("does not force-scroll once the reader has moved away from the bottom", () => {
    expect(
      isNearChatBottom({
        clientHeight: 600,
        scrollHeight: 1_000,
        scrollTop: 250,
      }),
    ).toBe(false);
  });

  it("uses instant scrolling while a response is streaming", () => {
    expect(getChatAutoScrollBehavior("submitted")).toBe("auto");
    expect(getChatAutoScrollBehavior("streaming")).toBe("auto");
    expect(getChatAutoScrollBehavior("ready")).toBe("smooth");
  });
});
