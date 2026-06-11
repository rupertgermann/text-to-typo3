import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  DELETE,
  GET,
  PATCH,
} from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import {
  LOCAL_TOKEN_USER_ID,
  seedLocalTokenUser,
  stubTokenAuthEnv,
} from "@/test/auth";
import { conversations, messages, users } from "@/lib/db/schema";

describe("single conversation routes", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    await seedLocalTokenUser();
    await db.insert(conversations).values({
      id: "owned",
      user_id: LOCAL_TOKEN_USER_ID,
      title: "Owned",
    });
    await db.insert(messages).values({
      conversation_id: "owned",
      role: "user",
      content: "Hello",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("reads and renames an owned conversation", async () => {
    const getResponse = await GET(
      new Request("http://localhost/api/conversations/owned") as never,
      { params: Promise.resolve({ id: "owned" }) },
    );
    const fetched = await getResponse.json();

    const patchResponse = await PATCH(
      new Request("http://localhost/api/conversations/owned", {
        method: "PATCH",
        body: JSON.stringify({ title: " Renamed " }),
      }) as never,
      { params: Promise.resolve({ id: "owned" }) },
    );
    const updated = await patchResponse.json();

    expect(fetched.messages).toHaveLength(1);
    expect(updated.title).toBe("Renamed");
  });

  it("updates the auto-approve writes toggle for an owned conversation", async () => {
    const patchResponse = await PATCH(
      new Request("http://localhost/api/conversations/owned", {
        method: "PATCH",
        body: JSON.stringify({ autoApproveWrites: true }),
      }) as never,
      { params: Promise.resolve({ id: "owned" }) },
    );
    const updated = await patchResponse.json();
    const stored = await db.query.conversations.findFirst({
      where: eq(conversations.id, "owned"),
    });

    expect(patchResponse.status).toBe(200);
    expect(updated.auto_approve_writes).toBe(1);
    expect(stored?.auto_approve_writes).toBe(1);
  });

  it("does not read, rename, or delete another user's conversation", async () => {
    await db.insert(users).values({
      id: "other-user",
      typo3_uid: "other-user",
      display_name: "Other User",
    });
    await db.insert(conversations).values({
      id: "other-conversation",
      user_id: "other-user",
      title: "Other",
    });

    const getResponse = await GET(
      new Request("http://localhost/api/conversations/other-conversation") as never,
      { params: Promise.resolve({ id: "other-conversation" }) },
    );
    const patchResponse = await PATCH(
      new Request("http://localhost/api/conversations/other-conversation", {
        method: "PATCH",
        body: JSON.stringify({ title: "Stolen" }),
      }) as never,
      { params: Promise.resolve({ id: "other-conversation" }) },
    );
    const deleteResponse = await DELETE(
      new Request("http://localhost/api/conversations/other-conversation") as never,
      { params: Promise.resolve({ id: "other-conversation" }) },
    );
    const otherConversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, "other-conversation"),
    });

    expect(getResponse.status).toBe(404);
    expect(patchResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(otherConversation?.title).toBe("Other");
  });

  it("deletes an owned conversation and cascades messages", async () => {
    const deleteResponse = await DELETE(
      new Request("http://localhost/api/conversations/owned") as never,
      { params: Promise.resolve({ id: "owned" }) },
    );
    const remainingMessages = await db.query.messages.findMany({
      where: eq(messages.conversation_id, "owned"),
    });

    expect(deleteResponse.status).toBe(204);
    expect(remainingMessages).toEqual([]);
  });
});
