import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationPage from "./page";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import {
  LOCAL_TOKEN_USER_ID,
  seedLocalTokenUser,
  stubTokenAuthEnv,
} from "@/test/auth";
import { conversations, messages } from "@/lib/db/schema";

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/user-settings", () => ({
  getPublicUserSettings: () =>
    Promise.resolve({
      userId: LOCAL_TOKEN_USER_ID,
      modelId: null,
      modelContextWindow: null,
      hasOpenAIKey: false,
      lmstudioBaseUrl: null,
      lmstudioModelId: null,
      customProviders: [],
    }),
}));
vi.mock("@/lib/models", () => ({
  getSelectedModelSummary: () => ({
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    providerName: "OpenAI",
  }),
}));

describe("conversation page token summary", () => {
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

  it("renders assistant token totals from the SQL aggregate", async () => {
    await db.insert(conversations).values({
      id: "owned",
      user_id: LOCAL_TOKEN_USER_ID,
      title: "Owned",
    });
    await db.insert(messages).values([
      {
        conversation_id: "owned",
        role: "user",
        content: "Ignore user usage",
        input_tokens: 999,
        output_tokens: 999,
      },
      {
        conversation_id: "owned",
        role: "assistant",
        content: "First assistant response",
        input_tokens: 120,
        output_tokens: 30,
      },
      {
        conversation_id: "owned",
        role: "assistant",
        content: "Second assistant response",
        input_tokens: 40,
        output_tokens: 12,
      },
    ]);

    const page = await ConversationPage({
      params: Promise.resolve({ id: "owned" }),
    });

    expect(collectText(page)).toContain("Conversation workspace · 160 in, 42 out");
  });
});

function collectText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (!node || typeof node !== "object") {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }

  if ("props" in node && node.props && typeof node.props === "object") {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }

  return "";
}
