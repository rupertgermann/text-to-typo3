import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { GET, PATCH } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { stubTokenAuthEnv } from "@/test/auth";
import { userSettings } from "@/lib/db/schema";
import {
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

describe("settings route", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeModel: FakeOpenAICompatibleServer | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
  });

  afterEach(async () => {
    await fakeModel?.close();
    fakeModel = null;
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
      modelContextWindow: 400000,
      hasOpenAIKey: true,
      lmstudioBaseUrl: "http://localhost:1234",
      lmstudioModelId: "local-model",
    });
    expect(JSON.stringify(patched)).not.toContain("sk-test-secret");
    expect(JSON.stringify(fetched)).not.toContain("sk-test-secret");
    expect(stored?.openai_api_key).toBeTruthy();
    expect(stored?.openai_api_key).not.toBe("sk-test-secret");
    expect(stored?.model_context_window).toBe(400000);
  });

  it("captures local model context windows when settings are saved", async () => {
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "local-chat", context_length: 32768 }],
    });

    const patchResponse = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          modelId: "local-chat",
          lmstudioBaseUrl: fakeModel.url,
          lmstudioModelId: "local-chat",
        }),
      }) as never,
    );
    const patched = await patchResponse.json();
    const stored = await db.query.userSettings.findFirst({
      where: eq(userSettings.user_id, "local-token-user"),
    });

    expect(patchResponse.status).toBe(200);
    expect(patched.modelContextWindow).toBe(32768);
    expect(stored?.model_context_window).toBe(32768);
  });

  it("persists custom providers with encrypted keys and rejects invalid base URLs", async () => {
    const invalidResponse = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          customProviders: [
            {
              displayName: "Broken",
              baseUrl: "not a url",
              apiKey: "secret-custom-key",
            },
          ],
        }),
      }) as never,
    );

    expect(invalidResponse.status).toBe(400);

    const patchResponse = await PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          customProviders: [
            {
              id: "openrouter",
              displayName: "OpenRouter",
              baseUrl: "https://openrouter.example/v1///",
              apiKey: "secret-custom-key",
            },
          ],
        }),
      }) as never,
    );
    const patched = await patchResponse.json();
    const getResponse = await GET();
    const fetched = await getResponse.json();
    const stored = await db.query.userSettings.findFirst({
      where: eq(userSettings.user_id, "local-token-user"),
    });

    expect(patchResponse.status).toBe(200);
    expect(patched.customProviders).toEqual([
      {
        id: "openrouter",
        displayName: "OpenRouter",
        baseUrl: "https://openrouter.example/v1",
        hasApiKey: true,
      },
    ]);
    expect(JSON.stringify(patched)).not.toContain("secret-custom-key");
    expect(JSON.stringify(fetched)).not.toContain("secret-custom-key");
    expect(stored?.custom_providers).toBeTruthy();
    expect(stored?.custom_providers).not.toContain("secret-custom-key");
  });
});
