import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GET, PATCH } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { stubTokenAuthEnv } from "@/test/auth";
import { userSettings } from "@/lib/db/schema";

describe("settings route", () => {
  let testDatabase: TestDatabase | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("persists settings while keeping OpenAI keys encrypted and private", async () => {
    const patchResponse = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          modelId: "gpt-5.4-mini",
          openaiApiKey: "sk-test-secret",
          lmstudioBaseUrl: "http://localhost:1234///",
          lmstudioModelId: "local-model",
        }),
      }) as never,
    );
    const patched = await patchResponse.json();
    const getResponse = await GET();
    const fetched = await getResponse.json();
    const stored = await db.query.userSettings.findFirst({
      where: eq(userSettings.user_id, "local-token-user"),
    });

    expect(patched).toMatchObject({
      modelId: "gpt-5.4-mini",
      hasOpenAIKey: true,
      lmstudioBaseUrl: "http://localhost:1234",
      lmstudioModelId: "local-model",
    });
    expect(JSON.stringify(patched)).not.toContain("sk-test-secret");
    expect(JSON.stringify(fetched)).not.toContain("sk-test-secret");
    expect(stored?.openai_api_key).toBeTruthy();
    expect(stored?.openai_api_key).not.toBe("sk-test-secret");
  });
});
