import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { conversations, messages, users } from "@/lib/db/schema";
import { deserializeMessageParts } from "@/lib/chat-message-parts";
import { resolveChatTurn } from "./chat-turn-resolution";

const USER_ID = "turn-user";

describe("chat turn resolution", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    vi.stubEnv("SESSION_SECRET", "complex_password_at_least_32_characters_long");

    await db.insert(users).values({
      id: USER_ID,
      typo3_uid: USER_ID,
      display_name: "Turn User",
    });
    await db.insert(conversations).values({
      id: "conversation-turns",
      user_id: USER_ID,
      title: "Turns",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("resolves a submitted user message and persists it", async () => {
    const turn = await resolveChatTurn({
      conversationId: "conversation-turns",
      trigger: "submit-message",
      uiMessages: [
        {
          id: "incoming-user",
          role: "user",
          parts: [{ type: "text", text: "Create a page" }],
        },
      ],
      userId: USER_ID,
    });

    const rows = await orderedMessages();

    expect(turn.userText).toBe("Create a page");
    expect(turn.continuationAssistantMessageId).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("user");
    expect(rows[0]?.content).toBe("Create a page");
  });

  it("resolves regeneration by deleting only the latest assistant response", async () => {
    await db.insert(messages).values([
      {
        id: "regen-user",
        conversation_id: "conversation-turns",
        role: "user",
        content: "Try again",
        tool_calls: JSON.stringify([{ type: "text", text: "Try again" }]),
        created_at: 1,
      },
      {
        id: "regen-assistant",
        conversation_id: "conversation-turns",
        role: "assistant",
        content: "Old answer",
        tool_calls: JSON.stringify([{ type: "text", text: "Old answer" }]),
        created_at: 2,
      },
    ]);

    const turn = await resolveChatTurn({
      conversationId: "conversation-turns",
      messageId: "regen-assistant",
      trigger: "regenerate-message",
      uiMessages: [
        {
          id: "regen-user",
          role: "user",
          parts: [{ type: "text", text: "Try again" }],
        },
        {
          id: "regen-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Old answer" }],
        },
      ],
      userId: USER_ID,
    });

    const rows = await orderedMessages();

    expect(turn.userText).toBe("Try again");
    expect(turn.continuationAssistantMessageId).toBeNull();
    expect(rows.map((message) => message.id)).toEqual(["regen-user"]);
  });

  it("resolves approval continuation by updating the assistant turn", async () => {
    const approvalPart = {
      type: "tool-WriteTable",
      toolCallId: "call-write",
      state: "approval-requested",
      input: { table: "pages", data: { title: "Draft" } },
      approval: { id: "approval-1" },
    } satisfies UIMessage["parts"][number];
    const respondedPart = {
      ...approvalPart,
      state: "approval-responded",
      approval: { id: "approval-1", approved: true },
    } as UIMessage["parts"][number];

    await db.insert(messages).values([
      {
        id: "approval-user",
        conversation_id: "conversation-turns",
        role: "user",
        content: "Write this",
        tool_calls: JSON.stringify([{ type: "text", text: "Write this" }]),
        created_at: 1,
      },
      {
        id: "approval-assistant",
        conversation_id: "conversation-turns",
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([approvalPart]),
        created_at: 2,
      },
    ]);

    const turn = await resolveChatTurn({
      conversationId: "conversation-turns",
      messageId: "approval-assistant",
      trigger: "submit-message",
      uiMessages: [
        {
          id: "approval-user",
          role: "user",
          parts: [{ type: "text", text: "Write this" }],
        },
        {
          id: "approval-assistant",
          role: "assistant",
          parts: [respondedPart],
        },
      ],
      userId: USER_ID,
    });

    const assistant = await db.query.messages.findFirst({
      where: eq(messages.id, "approval-assistant"),
    });
    const parts = deserializeMessageParts(assistant?.tool_calls);

    expect(turn.userText).toBe("Write this");
    expect(turn.continuationAssistantMessageId).toBe("approval-assistant");
    expect(parts).toEqual([respondedPart]);
  });
});

function orderedMessages() {
  return db.query.messages.findMany({
    where: eq(messages.conversation_id, "conversation-turns"),
    orderBy: [asc(messages.created_at)],
  });
}
