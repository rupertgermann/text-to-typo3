import { deferred } from "@/test/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createServer } from "node:http";
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
    vi.restoreAllMocks();
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

  it.each([
    { stage: "headers", stop: "deadline" },
    { stage: "body", stop: "deadline" },
    { stage: "headers", stop: "request abort" },
    { stage: "body", stop: "request abort" },
  ])("aborts stalled $stage on $stop", async ({ stage, stop }) => {
    stubTokenAuthEnv();
    const upstreamEntered = deferred<void>();
    const bodyReading = deferred<void>();
    const readJson = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(function (this: Response) {
      if (this.url.endsWith("/v1/models")) bodyReading.resolve();
      return readJson.call(this);
    });
    let upstreamClosed = false;
    const server = createServer((_request, response) => {
      response.on("close", () => { upstreamClosed = true; });
      if (stage === "body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"data":[');
      }
      upstreamEntered.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    if (stop === "deadline") timeoutSpy.mockImplementation(() => timeout(50));
    const controller = new AbortController();
    const response = POST(new NextRequest("http://localhost/api/settings/test-model-provider", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret-model-key" }),
    }));

    try {
      await upstreamEntered.promise;
      if (stop === "request abort") {
        if (stage === "body") await bodyReading.promise;
        controller.abort();
      }
      const result = await Promise.race([
        response,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      expect(result, "the route should finish while the provider is still stalled").not.toBeNull();
      expect(await result?.json()).toEqual({
        ok: false,
        error: { code: "unreachable", message: "The provider endpoint could not be reached." },
      });
      await vi.waitFor(() => expect(upstreamClosed).toBe(true));
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await response;
    }
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
