import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { LOCAL_TOKEN_USER_ID, seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";
import { userSettings } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import {
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

describe("models route", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeModels: FakeOpenAICompatibleServer[] = [];

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    await seedLocalTokenUser();
  });

  afterEach(async () => {
    await Promise.all(fakeModels.map((server) => server.close()));
    fakeModels = [];
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("merges OpenAI and LM Studio catalog entries for the user", async () => {
    const realFetch = globalThis.fetch;
    const fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "local-chat", context_length: 8192 }],
    });
    fakeModels.push(fakeModel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.openai.com/v1/models") {
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer sk-openai",
          });
          return Response.json({
            data: [
              { id: "gpt-5.5" },
              { id: "gpt-5.4" },
              { id: "gpt-5.4-mini" },
              { id: "gpt-4o" },
              { id: "text-embedding-3-small" },
            ],
          });
        }
        return realFetch(input, init);
      }),
    );
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      openai_api_key: encrypt("sk-openai"),
      lmstudio_base_url: fakeModel.url,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/models"),
    );
    const catalog = await response.json();

    expect(catalog.models.map((model: { id: string }) => model.id).sort()).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "local-chat",
    ]);
    expect(catalog.hasOpenAIKey).toBe(true);
  });

  it("merges configured custom provider models with provider attribution", async () => {
    const fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "custom-chat", context_length: 32768 }],
    });
    fakeModels.push(fakeModel);
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      custom_providers: JSON.stringify([
        {
          id: "custom-one",
          displayName: "Custom One",
          baseUrl: fakeModel.url,
          apiKey: encrypt("custom-secret"),
        },
      ]),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/models"),
    );
    const catalog = await response.json();

    expect(catalog.models).toContainEqual(
      expect.objectContaining({
        id: "custom:custom-one:custom-chat",
        name: "custom chat",
        provider: "custom",
        providerName: "Custom One",
        contextWindow: 32768,
      }),
    );
  });

  it("returns healthy provider models when another provider hangs", async () => {
    vi.stubEnv("MODEL_CATALOG_TIMEOUT_MS", "50");
    const [hangingProvider, healthyProvider] = await Promise.all([
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        modelsHang: true,
      }),
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        models: [{ id: "healthy-chat", context_length: 4096 }],
      }),
    ]);
    fakeModels.push(hangingProvider, healthyProvider);
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      custom_providers: JSON.stringify([
        {
          id: "hanging",
          displayName: "Hanging Provider",
          baseUrl: hangingProvider.url,
        },
        {
          id: "healthy",
          displayName: "Healthy Provider",
          baseUrl: healthyProvider.url,
        },
      ]),
    });

    const startedAt = performance.now();
    const response = await GET(
      new NextRequest("http://localhost/api/models"),
    );
    const catalog = await response.json();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        providerId: "hanging",
        providerName: "Hanging Provider",
        status: "unavailable",
        models: [],
      }),
      expect.objectContaining({
        providerId: "healthy",
        providerName: "Healthy Provider",
        status: "ok",
        models: [
          expect.objectContaining({
            id: "custom:healthy:healthy-chat",
          }),
        ],
      }),
    ]);
    expect(catalog.models).toContainEqual(
      expect.objectContaining({ id: "custom:healthy:healthy-chat" }),
    );
  });

  it("streams provider catalog results as each provider settles", async () => {
    vi.stubEnv("MODEL_CATALOG_TIMEOUT_MS", "50");
    const [hangingProvider, healthyProvider] = await Promise.all([
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        modelsHang: true,
      }),
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        models: [{ id: "healthy-chat", context_length: 4096 }],
      }),
    ]);
    fakeModels.push(hangingProvider, healthyProvider);
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      custom_providers: JSON.stringify([
        {
          id: "hanging",
          displayName: "Hanging Provider",
          baseUrl: hangingProvider.url,
        },
        {
          id: "healthy",
          displayName: "Healthy Provider",
          baseUrl: healthyProvider.url,
        },
      ]),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/models?stream=1"),
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(events[0]).toMatchObject({ type: "metadata" });
    expect(events[1]).toMatchObject({
      type: "provider",
      provider: {
        providerId: "healthy",
        status: "ok",
      },
    });
    expect(events[2]).toMatchObject({
      type: "provider",
      provider: {
        providerId: "hanging",
        status: "unavailable",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      catalog: {
        models: [expect.objectContaining({ id: "custom:healthy:healthy-chat" })],
      },
    });
  });
});
