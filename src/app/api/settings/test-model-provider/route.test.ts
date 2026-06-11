import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { setupTestDatabase, type TestDatabase } from "@/test/database";
import { stubTokenAuthEnv } from "@/test/auth";
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
