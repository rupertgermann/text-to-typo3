import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { LOCAL_TOKEN_USER_ID, seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";
import { userSettings } from "@/lib/db/schema";
import { listAvailableModelsForUser } from "@/lib/model-service";
import {
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

describe("model catalog assembly", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeServers: FakeOpenAICompatibleServer[] = [];

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    await seedLocalTokenUser();
  });

  afterEach(async () => {
    await Promise.all(fakeServers.map((server) => server.close()));
    fakeServers = [];
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("queries all providers concurrently, not sequentially", async () => {
    const delayMs = 400;
    const [providerA, providerB] = await Promise.all([
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        models: [{ id: "model-a" }],
        modelsDelayMs: delayMs,
      }),
      startFakeOpenAICompatibleServer({
        chatResponses: [],
        models: [{ id: "model-b" }],
        modelsDelayMs: delayMs,
      }),
    ]);
    fakeServers.push(providerA, providerB);
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      custom_providers: JSON.stringify([
        { id: "provider-a", displayName: "Provider A", baseUrl: providerA.url },
        { id: "provider-b", displayName: "Provider B", baseUrl: providerB.url },
      ]),
    });

    const startedAt = performance.now();
    const catalog = await listAvailableModelsForUser(LOCAL_TOKEN_USER_ID);
    const elapsed = performance.now() - startedAt;

    // Sequential fetches would take at least 2 × delayMs.
    expect(elapsed).toBeLessThan(delayMs * 2);
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        providerId: "provider-a",
        providerName: "Provider A",
        provider: "custom",
        status: "ok",
      }),
      expect.objectContaining({
        providerId: "provider-b",
        providerName: "Provider B",
        provider: "custom",
        status: "ok",
      }),
    ]);
    expect(
      catalog.models.map((model) => model.remoteModelId).sort(),
    ).toEqual(["model-a", "model-b"]);
  });

  it("reports an unreachable provider as unavailable while others succeed", async () => {
    const healthy = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "healthy-chat", context_length: 4096 }],
    });
    fakeServers.push(healthy);
    const unreachableUrl = "http://127.0.0.1:9";
    await db.insert(userSettings).values({
      user_id: LOCAL_TOKEN_USER_ID,
      custom_providers: JSON.stringify([
        { id: "dead", displayName: "Dead Provider", baseUrl: unreachableUrl },
        { id: "healthy", displayName: "Healthy Provider", baseUrl: healthy.url },
      ]),
    });

    const catalog = await listAvailableModelsForUser(LOCAL_TOKEN_USER_ID);

    expect(catalog.providers).toContainEqual(
      expect.objectContaining({ providerId: "dead", status: "unavailable", models: [] }),
    );
    expect(catalog.providers).toContainEqual(
      expect.objectContaining({ providerId: "healthy", status: "ok" }),
    );
    expect(catalog.models).toContainEqual(
      expect.objectContaining({ id: "custom:healthy:healthy-chat" }),
    );
  });
});
