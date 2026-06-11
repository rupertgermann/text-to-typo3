import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { conversations, messages, type Conversation, users } from "@/lib/db/schema";
import { persistChatTurn } from "./chat-turn-persistence";

const USER_ID = "persistence-user";

describe("chat turn persistence", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    vi.stubEnv("SESSION_SECRET", "complex_password_at_least_32_characters_long");

    await db.insert(users).values({
      id: USER_ID,
      typo3_uid: USER_ID,
      display_name: "Persistence User",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("inserts a new assistant message for a completed turn", async () => {
    const conversation = await seedConversation("insert-conversation", "Work");

    await persistChatTurn({
      assistantText: "Done.",
      continuationAssistantMessageId: null,
      conversation,
      responseParts: [{ type: "text", text: "Done." }],
      tokenUsage: { inputTokens: 7, outputTokens: 2 },
      userText: "Do this",
    });

    const assistant = await latestAssistant("insert-conversation");

    expect(assistant?.content).toBe("Done.");
    expect(assistant?.input_tokens).toBe(7);
    expect(assistant?.output_tokens).toBe(2);
  });

  it("updates the continuation assistant message instead of inserting a new row", async () => {
    const conversation = await seedConversation("continuation-conversation", "Work");
    await db.insert(messages).values({
      id: "continued-assistant",
      conversation_id: conversation.id,
      role: "assistant",
      content: "",
      tool_calls: JSON.stringify([{ type: "text", text: "" }]),
    });

    await persistChatTurn({
      assistantText: "Approved write completed.",
      continuationAssistantMessageId: "continued-assistant",
      conversation,
      responseParts: [{ type: "text", text: "Approved write completed." }],
      tokenUsage: { inputTokens: 11, outputTokens: 4 },
      userText: "Write it",
    });

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversation_id, conversation.id),
      orderBy: [asc(messages.created_at)],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("continued-assistant");
    expect(rows[0]?.content).toBe("Approved write completed.");
    expect(rows[0]?.input_tokens).toBe(11);
    expect(rows[0]?.output_tokens).toBe(4);
  });

  it("sets a fallback title and then applies generated title updates", async () => {
    const conversation = await seedConversation("title-conversation", "New conversation");

    const { titleGeneration } = await persistChatTurn({
      assistantText: "I can help with that.",
      continuationAssistantMessageId: null,
      conversation,
      responseParts: [{ type: "text", text: "I can help with that." }],
      titleGenerator: async () => "Generated TYPO3 Plan",
      tokenUsage: { inputTokens: null, outputTokens: null },
      userText: "Create a landing page draft",
    });

    await titleGeneration;

    const updated = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });

    expect(updated?.title).toBe("Generated TYPO3 Plan");
  });
});

async function seedConversation(
  id: string,
  title: string,
): Promise<Conversation> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      id,
      user_id: USER_ID,
      title,
    })
    .returning();

  return conversation!;
}

async function latestAssistant(conversationId: string) {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  return rows.findLast((message) => message.role === "assistant") ?? null;
}
