import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { GET, POST } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import {
  LOCAL_TOKEN_USER_ID,
  seedLocalTokenUser,
  stubTokenAuthEnv,
} from "@/test/auth";
import { conversations, messages } from "@/lib/db/schema";

describe("conversation collection routes", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    await seedLocalTokenUser();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("creates conversations and lists them by recent activity", async () => {
    await db.insert(conversations).values([
      {
        id: "older",
        user_id: LOCAL_TOKEN_USER_ID,
        title: "Older",
        updated_at: 100,
      },
      {
        id: "newer",
        user_id: LOCAL_TOKEN_USER_ID,
        title: "Newer",
        updated_at: 200,
      },
    ]);

    const createResponse = await POST(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: " Created from route " }),
      }) as never,
    );
    const created = await createResponse.json();
    const listResponse = await GET(
      new NextRequest("http://localhost/api/conversations"),
    );
    const listed = await listResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.title).toBe("Created from route");
    expect(listed.map((conversation: { id: string }) => conversation.id)).toEqual([
      created.id,
      "newer",
      "older",
    ]);
  });

  it("searches conversations by title and message content", async () => {
    await db.insert(conversations).values([
      { id: "match-title", user_id: LOCAL_TOKEN_USER_ID, title: "Launch plan" },
      { id: "match-message", user_id: LOCAL_TOKEN_USER_ID, title: "Other" },
      { id: "miss", user_id: LOCAL_TOKEN_USER_ID, title: "Nope" },
    ]);
    await db.insert(messages).values({
      conversation_id: "match-message",
      role: "user",
      content: "Please export the launch content",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/conversations?q=launch"),
    );
    const listed = await response.json();

    expect(listed.map((conversation: { id: string }) => conversation.id).sort()).toEqual([
      "match-message",
      "match-title",
    ]);
  });

  it("deleting a conversation cascades its messages", async () => {
    await db.insert(conversations).values({
      id: "cascade",
      user_id: LOCAL_TOKEN_USER_ID,
      title: "Cascade",
    });
    await db.insert(messages).values({
      conversation_id: "cascade",
      role: "user",
      content: "Delete me too",
    });

    await db.delete(conversations).where(eq(conversations.id, "cascade"));

    const remainingMessages = await db.query.messages.findMany({
      where: eq(messages.conversation_id, "cascade"),
      orderBy: [asc(messages.created_at)],
    });
    expect(remainingMessages).toEqual([]);
  });
});
