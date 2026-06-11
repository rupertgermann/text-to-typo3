import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { seedLocalTokenUser, LOCAL_TOKEN_USER_ID } from "@/test/auth";
import { conversations, messages } from "@/lib/db/schema";
import { getAssistantTokenUsage } from "@/lib/conversations";
import { sumTokenUsage } from "@/lib/token-usage";

describe("assistant token usage aggregate", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    await seedLocalTokenUser();
  });

  afterEach(() => {
    testDatabase?.cleanup();
    testDatabase = null;
  });

  async function createConversation(): Promise<string> {
    const [conversation] = await db
      .insert(conversations)
      .values({ user_id: LOCAL_TOKEN_USER_ID, title: "Test" })
      .returning();
    return conversation!.id;
  }

  it("reports unknown usage for a conversation without assistant messages", async () => {
    const conversationId = await createConversation();

    expect(await getAssistantTokenUsage(conversationId)).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("matches the in-memory sum over assistant messages", async () => {
    const conversationId = await createConversation();
    const rows = [
      { role: "user", content: "hi", input_tokens: 999, output_tokens: 999 },
      { role: "assistant", content: "a", input_tokens: 120, output_tokens: 30 },
      { role: "assistant", content: "b", input_tokens: null, output_tokens: 12 },
      { role: "assistant", content: "c", input_tokens: 40, output_tokens: null },
    ];
    await db.insert(messages).values(
      rows.map((row) => ({ ...row, conversation_id: conversationId })),
    );

    const expected = sumTokenUsage(
      rows
        .filter((row) => row.role === "assistant")
        .map((row) => ({
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        })),
    );

    expect(await getAssistantTokenUsage(conversationId)).toEqual(expected);
    expect(expected).toEqual({ inputTokens: 160, outputTokens: 42 });
  });

  it("ignores messages from other conversations", async () => {
    const conversationId = await createConversation();
    const otherConversationId = await createConversation();
    await db.insert(messages).values({
      conversation_id: otherConversationId,
      role: "assistant",
      content: "elsewhere",
      input_tokens: 7,
      output_tokens: 7,
    });

    expect(await getAssistantTokenUsage(conversationId)).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});
