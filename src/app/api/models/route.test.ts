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
  let fakeModel: FakeOpenAICompatibleServer | null = null;

  beforeEach(async () => {
    testDatabase = setupTestDatabase();
    stubTokenAuthEnv();
    await seedLocalTokenUser();
  });

  afterEach(async () => {
    await fakeModel?.close();
    fakeModel = null;
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("merges OpenAI and LM Studio catalog entries for the user", async () => {
    const realFetch = globalThis.fetch;
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      models: [{ id: "local-chat", context_length: 8192 }],
    });
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
              { id: "gpt-5.4-mini" },
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
      "gpt-5.4-mini",
      "local-chat",
    ]);
    expect(catalog.hasOpenAIKey).toBe(true);
  });
});
