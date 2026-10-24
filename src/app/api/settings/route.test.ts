import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createServer } from "node:http";
import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { POST as chatPost } from "@/app/api/chat/route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";
import { getResolvedUserSettings, upsertUserSettings } from "@/lib/user-settings";
import { conversations, messages, userSettings } from "@/lib/db/schema";
import { resolveChatProvider } from "@/lib/chat-provider-resolution";
import { resetMcpCachesForTests } from "@/lib/mcp";
import { startFakeMcpServer } from "@/test/fake-mcp-server";
import {
  createTextResponse,
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

describe("settings route", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeModel: FakeOpenAICompatibleServer | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(async () => {
    await fakeModel?.close();
    fakeModel = null;
    resetMcpCachesForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it.each([false, true])("preserves concurrent partial saves with an existing row = %s", async (existingRow) => {
    await seedLocalTokenUser();
    if (existingRow) {
      await upsertUserSettings("local-token-user", {
        customProviders: [{
          id: "saved", displayName: "Saved", baseUrl: "https://saved.example/v1",
          apiKey: "saved-custom-secret",
        }],
      });
    }

    const responses = await Promise.all([
      patch({ openaiApiKey: "new-openai-secret" }),
      patch({ lmstudioModelId: "local-chat" }),
    ]);
    const settings = await getResolvedUserSettings("local-token-user");

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(settings.openAiApiKey).toBe("new-openai-secret");
    expect(settings.lmstudioModelId).toBe("local-chat");
    if (existingRow) {
      expect(settings.customProviders[0]?.apiKey).toBe("saved-custom-secret");
    }
  });

  it("preserves a concurrent custom secret rotation when another save omits the secret", async () => {
    await seedLocalTokenUser();
    const provider = { id: "saved", displayName: "Saved", baseUrl: "https://saved.example/v1" };
    await upsertUserSettings("local-token-user", {
      customProviders: [{ ...provider, apiKey: "old-custom-secret" }],
    });

    const responses = await Promise.all([
      patch({ customProviders: [{ ...provider, apiKey: "new-custom-secret" }] }),
      patch({ customProviders: [{ ...provider, displayName: "Renamed" }] }),
    ]);
    const settings = await getResolvedUserSettings("local-token-user");

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(settings.customProviders[0]).toMatchObject({
      displayName: "Renamed", apiKey: "new-custom-secret",
    });
  });

  it.each([
    { change: "model", modelId: "gpt-5.4-mini", modelContextWindow: 400000 },
    { change: "provider URL", modelId: "local-chat", modelContextWindow: 65536 },
    { change: "cleared model", modelId: null, modelContextWindow: null },
  ])("discards delayed catalog metadata after $change changes", async ({ change, modelId, modelContextWindow }) => {
    await seedLocalTokenUser();
    const catalog = await startDeferredCatalog();
    let earlier: Promise<Response> | undefined;
    try {
      earlier = patch({ modelId: "local-chat", lmstudioModelId: "local-chat", lmstudioBaseUrl: catalog.url });
      await catalog.entered;
      fakeModel = await startFakeOpenAICompatibleServer({
        chatResponses: [],
        models: [{ id: "local-chat", context_length: 65536 }],
      });
      const later = await patch(change === "provider URL"
        ? { lmstudioBaseUrl: fakeModel.url }
        : { modelId });
      catalog.release();
      const first = await earlier;
      const fetched = await (await GET()).json();

      expect([first.status, later.status]).toEqual([200, 200]);
      expect(fetched).toMatchObject({ modelId, modelContextWindow });
    } finally {
      catalog.release();
      await earlier;
      await catalog.close();
    }
  });

  it("discards delayed catalog metadata after credentials change for the same provider", async () => {
    await seedLocalTokenUser();
    const catalog = await startDeferredCatalog();
    const provider = { id: "saved", displayName: "Saved", baseUrl: catalog.url };
    let earlier: Promise<Response> | undefined;
    try {
      earlier = patch({
        modelId: "custom:saved:local-chat",
        customProviders: [{ ...provider, apiKey: "old-custom-secret" }],
      });
      await catalog.entered;
      const later = await patch({
        customProviders: [{ ...provider, apiKey: "new-custom-secret" }],
      });
      catalog.release();
      const first = await earlier;
      const fetched = await (await GET()).json();

      expect([first.status, later.status]).toEqual([200, 200]);
      expect(fetched).toMatchObject({
        modelId: "custom:saved:local-chat", modelContextWindow: 65536,
      });
    } finally {
      catalog.release();
      await earlier;
      await catalog.close();
    }
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

  it.each(["custom", "lmstudio"])("retains known capacity when an unchanged %s catalog is unavailable", async (kind) => {
    await seedLocalTokenUser();
    const selection = kind === "custom"
      ? { modelId: "custom:saved:local-chat", customProviders: [{ id: "saved", displayName: "Saved", baseUrl: "http://provider.invalid/v1" }] }
      : { modelId: "local-chat", lmstudioModelId: "local-chat", lmstudioBaseUrl: "http://provider.invalid/v1" };
    await upsertUserSettings("local-token-user", { ...selection, modelContextWindow: 131072 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));

    const response = await patch(selection);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelContextWindow: 131072 });
    expect(await getResolvedUserSettings("local-token-user")).toMatchObject({ modelContextWindow: 131072 });
  });

  it.each([
    { modelId: "custom:saved:other-model" },
    { customProviders: [{ id: "saved", displayName: "Saved", baseUrl: "http://other.invalid/v1" }] },
    { modelId: "local-chat", lmstudioModelId: "local-chat", lmstudioBaseUrl: "http://local.invalid/v1" },
  ])("clears old capacity when the selected model or provider changes without discovery ($modelId)", async (change) => {
    await seedLocalTokenUser();
    await upsertUserSettings("local-token-user", {
      modelId: "custom:saved:local-chat", modelContextWindow: 131072,
      customProviders: [{ id: "saved", displayName: "Saved", baseUrl: "http://provider.invalid/v1" }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));

    const response = await patch(change);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelContextWindow: null });
  });

  it("retains capacity through unrelated provider edits and refreshes it after recovery", async () => {
    await seedLocalTokenUser();
    const selected = { id: "saved", displayName: "Saved", baseUrl: "http://provider.invalid/v1", apiKey: "same-provider-key" };
    const other = { id: "other", displayName: "Other", baseUrl: "http://other.invalid/v1" };
    await upsertUserSettings("local-token-user", {
      modelId: "custom:saved:local-chat", modelContextWindow: 131072,
      customProviders: [selected, other],
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));
    const response = await patch({ customProviders: [{ ...other, displayName: "Renamed" }, selected] });
    expect(await response.json()).toMatchObject({ modelContextWindow: 131072 });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "local-chat", context_length: 262144 }] })));
    const recovered = await patch({ modelId: "custom:saved:local-chat" });
    expect(await recovered.json()).toMatchObject({ modelContextWindow: 262144 });
  });

  it("clears a local model's old capacity atomically before discovering a changed endpoint", async () => {
    await seedLocalTokenUser();
    await upsertUserSettings("local-token-user", {
      modelId: "local-chat", lmstudioModelId: "local-chat",
      lmstudioBaseUrl: "http://first.invalid/v1", modelContextWindow: 131072,
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(await getResolvedUserSettings("local-token-user")).toMatchObject({ modelContextWindow: null });
      return Response.json({ error: "Unavailable" }, { status: 503 });
    }));
    const response = await patch({ lmstudioBaseUrl: "http://second.invalid/v1" });
    expect(await response.json()).toMatchObject({ modelContextWindow: null });
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

  it.each([false, true])("uses LM Studio capacity for a colliding model with OpenAI enabled = %s", async (openAiEnabled) => {
    await seedLocalTokenUser();
    vi.stubEnv("OPENAI_API_KEY", openAiEnabled ? "test-openai-key" : "");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      return Response.json({ data: [{
        id: "gpt-5.4-mini",
        ...(url.startsWith("http://local-provider.invalid") ? { context_length: 8192 } : {}),
      }] });
    }));

    const response = await patch({
      modelId: "gpt-5.4-mini", lmstudioModelId: "gpt-5.4-mini",
      lmstudioBaseUrl: "http://local-provider.invalid/v1",
    });
    const settings = await getResolvedUserSettings("local-token-user");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelContextWindow: 8192 });
    expect(settings.modelContextWindow).toBe(8192);
    expect(resolveChatProvider({ settings })).toMatchObject({
      providerKind: "lmstudio", contextWindow: 8192,
    });
  });

  it("budgets chat history using the saved capacity of a colliding local model", async () => {
    await seedLocalTokenUser();
    fakeModel = await startFakeOpenAICompatibleServer({
      models: [{ id: "gpt-5.4-mini", context_length: 8192 }],
      chatResponses: [createTextResponse({ text: "ok" })],
    });
    const mcp = await startFakeMcpServer();
    vi.stubEnv("TYPO3_MCP_URL", mcp.url);
    try {
      const saved = await patch({
        modelId: "gpt-5.4-mini", lmstudioModelId: "gpt-5.4-mini",
        lmstudioBaseUrl: fakeModel.url,
      });
      expect(saved.status).toBe(200);
      await db.insert(conversations).values({ id: "capacity", user_id: "local-token-user", title: "Capacity test" });
      const oldPrompt = "words ".repeat(8000);
      await db.insert(messages).values([
        { id: "old-user", conversation_id: "capacity", role: "user", content: oldPrompt, created_at: 1 },
        { id: "old-assistant", conversation_id: "capacity", role: "assistant", content: "Previous answer", created_at: 2 },
      ]);

      const response = await chatPost(new NextRequest("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          conversationId: "capacity",
          messages: [{ id: "new-user", role: "user", parts: [{ type: "text", text: "Continue" }] }],
        }),
      }));
      expect(response.status).toBe(200);
      await response.text();

      expect(fakeModel.chatRequests).toHaveLength(1);
      const outgoing = JSON.stringify(fakeModel.chatRequests[0]);
      expect(outgoing.includes(oldPrompt)).toBe(false);
      expect(outgoing).not.toContain("Previous answer");
      expect(outgoing).toContain("Continue");
      expect(Math.ceil(outgoing.length / 4)).toBeLessThan(8192);
    } finally {
      await mcp.close();
    }
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

function patch(body: object) {
  return PATCH(new NextRequest("http://localhost/api/settings", {
    method: "PATCH", body: JSON.stringify(body),
  }));
}

async function startDeferredCatalog() {
  let release = () => {};
  let markEntered = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const server = createServer(async (request, response) => {
    const newCredentials = request.headers.authorization === "Bearer new-custom-secret";
    if (!newCredentials) {
      markEntered();
      await released;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "local-chat", context_length: newCredentials ? 65536 : 32768 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing catalog server port");
  return {
    url: `http://127.0.0.1:${address.port}`, entered, release,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
