import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import {
  LOCAL_TOKEN_USER_ID,
  seedLocalTokenUser,
  stubTokenAuthEnv,
} from "@/test/auth";
import { conversations, messages, users } from "@/lib/db/schema";

describe("conversation export route", () => {
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

  it("exports ordered transcript metadata and serialized tool-call data", async () => {
    await db.insert(conversations).values({
      id: "export-me",
      user_id: LOCAL_TOKEN_USER_ID,
      title: "Export Me",
    });
    await db.insert(messages).values([
      {
        conversation_id: "export-me",
        role: "user",
        content: "Read records",
        created_at: 100,
      },
      {
        conversation_id: "export-me",
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([
          {
            type: "tool-ReadTable",
            toolCallId: "call-read",
            state: "output-available",
            input: { table: "tt_content" },
            output: { rows: [{ uid: 1, header: "Hero" }] },
          },
        ]),
        created_at: 101,
      },
    ]);

    const response = await GET(
      new Request("http://localhost/api/conversations/export-me/export") as never,
      { params: Promise.resolve({ id: "export-me" }) },
    );
    const markdown = await response.text();

    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Content-Disposition")).toContain("export-me");
    expect(markdown).toContain("# Export Me");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("Read records");
    expect(markdown).toContain("tool-ReadTable");
    expect(markdown).toContain("Hero");
  });

  it("does not export another user's conversation", async () => {
    await db.insert(users).values({
      id: "other-user",
      typo3_uid: "other-user",
      display_name: "Other User",
    });
    await db.insert(conversations).values({
      id: "other-export",
      user_id: "other-user",
      title: "Other Export",
    });

    const response = await GET(
      new Request("http://localhost/api/conversations/other-export/export") as never,
      { params: Promise.resolve({ id: "other-export" }) },
    );

    expect(response.status).toBe(404);
  });
});
