import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { setupTestDatabase, type TestDatabase } from "@/test/database";
import { LOCAL_TOKEN_USER_ID, seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";
import { upsertUserSettings } from "@/lib/user-settings";
import {
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

describe("model provider connection test route", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeModel: FakeOpenAICompatibleServer | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
  });

  afterEach(async () => {
    await fakeModel?.close();
    fakeModel = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("requires authentication", async () => {
    vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
    vi.stubEnv("TYPO3_MCP_URL", "");
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "");

    const response = await POST(
      new Request("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "http://localhost:1234" }),
      }) as never,
    );

    expect(response.status).toBe(401);
  });

  it("reports model counts on success without leaking API keys", async () => {
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "local-model" }, { id: "another-local-model" }],
    });
    stubTokenAuthEnv();

    const response = await POST(
      new Request("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: fakeModel.url,
          apiKey: "secret-model-key",
        }),
      }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, modelCount: 2 });
    expect(JSON.stringify(body)).not.toContain("secret-model-key");
  });

  it.each(["environment", "saved", "explicit"])(
    "keeps %s OpenAI credentials on the OpenAI endpoint",
    async (keySource) => {
      stubTokenAuthEnv();
      vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
      if (keySource === "saved") {
        await seedLocalTokenUser();
        await upsertUserSettings(LOCAL_TOKEN_USER_ID, {
          openaiApiKey: "synthetic-saved-key",
        });
      }
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ data: [{ id: "test-model" }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(
        new NextRequest("http://localhost/api/settings/test-model-provider", {
          method: "POST",
          body: JSON.stringify({
            provider: "openai",
            baseUrl: "https://untrusted.example/v1",
            ...(keySource === "explicit" ? { apiKey: "synthetic-explicit-key" } : {}),
          }),
        }),
      );

      expect(await response.json()).toEqual({ ok: true, modelCount: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        `Bearer synthetic-${keySource}-key`,
      );
    },
  );

  it.each([
    { baseUrl: "https://saved.example/v1", apiKey: undefined, expectedKey: "saved-custom-key" },
    { baseUrl: "https://untrusted.example/v1", apiKey: undefined, expectedKey: null },
    { baseUrl: "https://untrusted.example/v1", apiKey: "explicit-custom-key", expectedKey: "explicit-custom-key" },
  ])("uses only credentials belonging to the custom endpoint ($baseUrl, $expectedKey)", async ({ baseUrl, apiKey, expectedKey }) => {
    stubTokenAuthEnv();
    await seedLocalTokenUser();
    await upsertUserSettings(LOCAL_TOKEN_USER_ID, {
      customProviders: [{
        id: "saved-provider",
        displayName: "Saved provider",
        baseUrl: "https://saved.example/v1",
        apiKey: "saved-custom-key",
      }],
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: [{ id: "test-model" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new NextRequest("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({ provider: "custom", customProviderId: "saved-provider", baseUrl, apiKey }),
      }),
    );

    expect(await response.json()).toEqual({ ok: true, modelCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${baseUrl}/models`);
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      expectedKey ? `Bearer ${expectedKey}` : null,
    );
  });

  it("categorizes bad URLs, auth failures, and unreachable providers", async () => {
    stubTokenAuthEnv();

    const badUrlResponse = await POST(
      new Request("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "not a url" }),
      }) as never,
    );
    const badUrlBody = await badUrlResponse.json();

    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [],
      modelsStatus: 401,
    });
    const authResponse = await POST(
      new Request("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: fakeModel.url,
          apiKey: "secret-model-key",
        }),
      }) as never,
    );
    const authBody = await authResponse.json();
    await fakeModel.close();
    fakeModel = null;

    const unreachableResponse = await POST(
      new Request("http://localhost/api/settings/test-model-provider", {
        method: "POST",
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:9" }),
      }) as never,
    );
    const unreachableBody = await unreachableResponse.json();

    expect(badUrlBody).toMatchObject({ ok: false, error: { code: "bad_url" } });
    expect(authBody).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect(unreachableBody).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
    expect(JSON.stringify(authBody)).not.toContain("secret-model-key");
  });
});
