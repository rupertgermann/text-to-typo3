import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { isToolUIPart, type UIMessage } from "ai";
import { POST } from "./route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { conversations, messages, userSettings, users } from "@/lib/db/schema";
import { deserializeMessageParts } from "@/lib/chat-message-parts";
import { encrypt } from "@/lib/crypto";
import { resetMcpCachesForTests } from "@/lib/mcp";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import {
  createToolCallResponse,
  createTextResponse,
  startFakeOpenAICompatibleServer,
  type FakeOpenAICompatibleServer,
} from "@/test/fake-openai-compatible-server";

const LOCAL_USER_ID = "local-token-user";

describe("chat route integration", () => {
  let testDatabase: TestDatabase | null = null;
  let fakeMcp: FakeMcpServer | null = null;
  let fakeModel: FakeOpenAICompatibleServer | null = null;

  beforeEach(() => {
    testDatabase = setupTestDatabase();
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
    vi.stubEnv("SESSION_SECRET", "complex_password_at_least_32_characters_long");
    vi.stubEnv("TYPO3_LOCAL_USER_NAME", "Local Test Editor");
  });

  afterEach(async () => {
    await fakeModel?.close();
    await fakeMcp?.close();
    fakeModel = null;
    fakeMcp = null;
    resetMcpCachesForTests();
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("rejects unauthenticated OAuth-mode chat requests", async () => {
    vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
    vi.stubEnv("TYPO3_MCP_URL", "");
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "");

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify({
          conversationId: "missing",
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        }),
      }) as never,
    );

    expect(response.status).toBe(401);
  });

  it("streams a tool-call response through fake model and MCP servers in token mode", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createToolCallResponse({
          toolCallId: "call-page-tree",
          toolName: "GetPageTree",
          argumentsJson: "{}",
        }),
        createTextResponse({
          text: "The TYPO3 page tree starts with Home.",
          usage: { inputTokens: 42, outputTokens: 9 },
        }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });

    vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
    vi.stubEnv("TYPO3_MCP_URL", fakeMcp.url);
    vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "test-mcp-token");

    await db.insert(users).values({
      id: LOCAL_USER_ID,
      typo3_uid: LOCAL_USER_ID,
      display_name: "Local Test Editor",
    });
    await db.insert(conversations).values({
      id: "conversation-1",
      user_id: LOCAL_USER_ID,
      title: "New conversation",
    });
    await db.insert(userSettings).values({
      user_id: LOCAL_USER_ID,
      model_id: "fake-typo3-model",
      model_context_window: 4096,
      lmstudio_model_id: "fake-typo3-model",
      lmstudio_base_url: fakeModel.url,
    });
    await db.insert(messages).values({
      id: "previous-user-message",
      conversation_id: "conversation-1",
      role: "user",
      content: "Show me the page tree",
      tool_calls: JSON.stringify([
        { type: "text", text: "Show me the page tree" },
      ]),
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: "conversation-1",
          messages: [
            {
              id: "user-message",
              role: "user",
              parts: [{ type: "text", text: "Read the page tree" }],
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    const streamBody = await response.text();

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversation_id, "conversation-1"),
      orderBy: [asc(messages.created_at)],
    });
    const assistant = rows.findLast((message) => message.role === "assistant");
    const localUser = await db.query.users.findFirst({
      where: eq(users.id, LOCAL_USER_ID),
    });

    expect(streamBody).toContain("The TYPO3 page tree starts with Home.");
    expect(localUser?.display_name).toBe("Local Test Editor");
    expect(fakeModel.chatRequests).toHaveLength(2);
    expect(fakeModel.modelsRequests).toHaveLength(0);
    expect(fakeMcp.toolCalls).toEqual([
      { name: "GetPageTree", arguments: {} },
    ]);
    expect(assistant?.content).toBe("The TYPO3 page tree starts with Home.");
    expect(assistant?.input_tokens).toBe(42);
    expect(assistant?.output_tokens).toBe(9);
    expect(JSON.stringify(deserializeMessageParts(assistant?.tool_calls))).toContain(
      "GetPageTree",
    );
  });

  it("persists null token usage when the provider reports no usage", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "Usage was not reported." })],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-no-usage",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const response = await postChat({
      conversationId: "conversation-no-usage",
      text: "Answer without usage",
    });

    expect(response.status).toBe(200);
    await response.text();

    const assistant = await latestAssistantMessage("conversation-no-usage");
    expect(assistant?.content).toBe("Usage was not reported.");
    expect(assistant?.input_tokens).toBeNull();
    expect(assistant?.output_tokens).toBeNull();
  });

  it("budgets oversized tool history out of the model request without changing persisted rows", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "Budgeted answer." })],
      models: [{ id: "fake-typo3-model", context_length: 300 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-budget",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      modelContextWindow: 300,
    });
    const hugeToolOutput = "very-large-tool-output ".repeat(1000);
    await db.insert(messages).values({
      id: "old-user-message",
      conversation_id: "conversation-budget",
      role: "user",
      content: "Read many old rows",
      tool_calls: JSON.stringify([{ type: "text", text: "Read many old rows" }]),
    });
    await db.insert(messages).values({
      id: "old-assistant-tool-output",
      conversation_id: "conversation-budget",
      role: "assistant",
      content: "",
      tool_calls: JSON.stringify([
        {
          type: "tool-ReadTable",
          toolCallId: "call-huge-read",
          state: "output-available",
          input: { table: "tt_content" },
          output: { records: hugeToolOutput },
        },
      ]),
    });

    const response = await postChat({
      conversationId: "conversation-budget",
      text: "Newest question should stay",
    });

    expect(response.status).toBe(200);
    await response.text();

    const firstModelRequest = fakeModel.chatRequests[0] as {
      messages?: unknown[];
    };
    const requestPayload = JSON.stringify(firstModelRequest.messages);
    const persistedHugeMessage = await db.query.messages.findFirst({
      where: eq(messages.id, "old-assistant-tool-output"),
    });

    expect(requestPayload).toContain("Newest question should stay");
    expect(requestPayload).not.toContain("very-large-tool-output");
    expect(fakeModel.modelsRequests).toHaveLength(0);
    expect(persistedHugeMessage?.tool_calls).toContain("very-large-tool-output");
  });

  it("regenerates only the latest assistant response for the preceding user turn", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "Regenerated answer." })],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-regenerate",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });
    await db.insert(messages).values({
      id: "regen-user-message",
      conversation_id: "conversation-regenerate",
      role: "user",
      content: "Try this again",
      tool_calls: JSON.stringify([{ type: "text", text: "Try this again" }]),
    });
    await db.insert(messages).values({
      id: "regen-assistant-message",
      conversation_id: "conversation-regenerate",
      role: "assistant",
      content: "First answer.",
      tool_calls: JSON.stringify([{ type: "text", text: "First answer." }]),
    });

    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: "conversation-regenerate",
          trigger: "regenerate-message",
          messageId: "regen-assistant-message",
          messages: [
            {
              id: "regen-user-message",
              role: "user",
              parts: [{ type: "text", text: "Try this again" }],
            },
            {
              id: "regen-assistant-message",
              role: "assistant",
              parts: [{ type: "text", text: "First answer." }],
            },
          ],
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await response.text();

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversation_id, "conversation-regenerate"),
      orderBy: [asc(messages.created_at)],
    });
    const assistantMessages = rows.filter((message) => message.role === "assistant");

    expect(fakeModel.chatRequests).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe("Regenerated answer.");
  });

  it("replaces the default first-words title with a generated title after the first exchange", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createTextResponse({ text: "I can help with that." }),
        createTextResponse({ text: "TYPO3 Landing Page Work" }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-title",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const response = await postChat({
      conversationId: "conversation-title",
      text: "Create a landing page draft",
    });

    expect(response.status).toBe(200);
    await response.text();

    await expectConversationTitle(
      "conversation-title",
      "TYPO3 Landing Page Work",
    );
  });

  it("keeps the first-words fallback when title generation fails", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "I can help with that." })],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-title-fallback",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const response = await postChat({
      conversationId: "conversation-title-fallback",
      text: "Create a landing page draft with teaser copy",
    });

    expect(response.status).toBe(200);
    await response.text();

    await expectConversationTitle(
      "conversation-title-fallback",
      "Create a landing page draft with",
    );
  });

  it("does not generate a title for an already renamed conversation", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createTextResponse({ text: "I can help with that." }),
        createTextResponse({ text: "Should Not Be Used" }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-renamed",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      title: "Editorial Planning",
    });

    const response = await postChat({
      conversationId: "conversation-renamed",
      text: "Create a landing page draft",
    });

    expect(response.status).toBe(200);
    await response.text();

    await expectConversationTitle("conversation-renamed", "Editorial Planning");
    expect(fakeModel.chatRequests).toHaveLength(1);
  });

  it("does not persist an assistant message when the provider stream fails", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [],
      chatStatus: 500,
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-provider-error",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const response = await postChat({
      conversationId: "conversation-provider-error",
      text: "Trigger a provider error",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    const assistant = await latestAssistantMessage("conversation-provider-error");
    expect(assistant).toBeNull();
  });

  it("returns sanitized MCP connection errors before streaming starts", async () => {
    fakeMcp = await startFakeMcpServer({ statusByMethod: { "tools/list": 401 } });
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "Should not be used." })],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-mcp-error",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const response = await postChat({
      conversationId: "conversation-mcp-error",
      text: "Read the page tree",
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toEqual({
      code: "upstream_error",
      message: "TYPO3 MCP authentication failed. Check the configured token.",
    });
    expect(JSON.stringify(body)).not.toContain("test-mcp-token");
  });

  it("returns a categorized MCP error when the MCP server hangs", async () => {
    fakeMcp = await startFakeMcpServer({ hangMethods: ["tools/list"] });
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [createTextResponse({ text: "Should not be used." })],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-mcp-hang",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
    });

    const startedAt = Date.now();
    const response = await postChat({
      conversationId: "conversation-mcp-hang",
      text: "Read the page tree",
    });
    const body = await response.json();

    expect(Date.now() - startedAt).toBeLessThan(6_500);
    expect(response.status).toBe(502);
    expect(body.error).toEqual({
      code: "upstream_error",
      message: "TYPO3 MCP endpoint unreachable. Check Settings.",
    });
    expect(fakeModel.chatRequests).toHaveLength(0);
  }, 10_000);

  it("pauses write tools until the user approves them", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createToolCallResponse({
          toolCallId: "call-write-approval",
          toolName: "WriteTable",
          argumentsJson: JSON.stringify({
            table: "tt_content",
            data: { header: "Approved headline" },
          }),
        }),
        createTextResponse({ text: "Approved write completed." }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-write-approval",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      title: "Approval work",
    });

    const firstResponse = await postChat({
      conversationId: "conversation-write-approval",
      text: "Create a content element",
    });

    expect(firstResponse.status).toBe(200);
    await firstResponse.text();
    expect(fakeMcp.toolCalls).toEqual([]);

    const pendingAssistant = await latestAssistantMessage(
      "conversation-write-approval",
    );
    const pendingParts = deserializeMessageParts(pendingAssistant?.tool_calls) ?? [];
    const pendingWrite = pendingParts.find(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: string }).type === "tool-WriteTable",
    ) as {
      approval?: { id: string };
      input?: unknown;
      state?: string;
    } | undefined;

    expect(pendingWrite?.state).toBe("approval-requested");
    expect(pendingWrite?.input).toEqual({
      table: "tt_content",
      data: { header: "Approved headline" },
    });

    const approvedMessages = await persistedUiMessages(
      "conversation-write-approval",
      (part) => {
        if (
          !isToolUIPart(part) ||
          part.type !== "tool-WriteTable" ||
          part.state !== "approval-requested"
        ) {
          return part;
        }

        return {
          ...part,
          state: "approval-responded",
          approval: {
            id: part.approval.id,
            approved: true,
          },
        } as UIMessage["parts"][number];
      },
    );
    const approvalResponse = await postChatMessages({
      conversationId: "conversation-write-approval",
      messageId: pendingAssistant!.id,
      messages: approvedMessages,
    });

    expect(approvalResponse.status).toBe(200);
    await approvalResponse.text();

    expect(fakeMcp.toolCalls).toEqual([
      {
        name: "WriteTable",
        arguments: {
          table: "tt_content",
          data: { header: "Approved headline" },
        },
      },
    ]);
    expect(
      (await latestAssistantMessage("conversation-write-approval"))?.content,
    ).toBe("Approved write completed.");

    const approvalRows = await db.query.messages.findMany({
      where: eq(messages.conversation_id, "conversation-write-approval"),
      orderBy: [asc(messages.created_at)],
    });
    const assistantRows = approvalRows.filter(
      (message) => message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.id).toBe(pendingAssistant?.id);
    expect(assistantRows[0]?.tool_calls).toContain("output-available");
    expect(assistantRows[0]?.tool_calls).not.toContain("approval-responded");
  });

  it("rejects write tools without calling MCP and forwards the rejection reason", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createToolCallResponse({
          toolCallId: "call-write-reject",
          toolName: "WriteTable",
          argumentsJson: JSON.stringify({
            table: "tt_content",
            data: { header: "Rejected headline" },
          }),
        }),
        createTextResponse({ text: "I will adjust the write." }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-write-reject",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      title: "Rejection work",
    });

    const firstResponse = await postChat({
      conversationId: "conversation-write-reject",
      text: "Create a content element",
    });
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();

    const pendingAssistant = await latestAssistantMessage(
      "conversation-write-reject",
    );
    const pendingParts = deserializeMessageParts(pendingAssistant?.tool_calls) ?? [];
    const pendingWrite = pendingParts.find(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: string }).type === "tool-WriteTable",
    ) as { approval?: { id: string }; state?: string } | undefined;

    expect(pendingWrite?.state).toBe("approval-requested");

    const rejectedMessages = await persistedUiMessages(
      "conversation-write-reject",
      (part) => {
        if (
          !isToolUIPart(part) ||
          part.type !== "tool-WriteTable" ||
          part.state !== "approval-requested"
        ) {
          return part;
        }

        return {
          ...part,
          state: "approval-responded",
          approval: {
            id: part.approval.id,
            approved: false,
            reason: "Use the draft workspace first",
          },
        } as UIMessage["parts"][number];
      },
    );
    const rejectionResponse = await postChatMessages({
      conversationId: "conversation-write-reject",
      messageId: pendingAssistant!.id,
      messages: rejectedMessages,
    });

    expect(rejectionResponse.status).toBe(200);
    await rejectionResponse.text();

    expect(fakeMcp.toolCalls).toEqual([]);
    expect(JSON.stringify(fakeModel.chatRequests[1])).toContain(
      "Use the draft workspace first",
    );
    expect(
      (await latestAssistantMessage("conversation-write-reject"))?.content,
    ).toBe("I will adjust the write.");
  });

  it("executes write tools without pausing when auto-approve writes is enabled", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createToolCallResponse({
          toolCallId: "call-write-auto",
          toolName: "WriteTable",
          argumentsJson: JSON.stringify({
            table: "tt_content",
            data: { header: "Auto-approved headline" },
          }),
        }),
        createTextResponse({ text: "Auto-approved write completed." }),
      ],
      models: [{ id: "fake-typo3-model", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-write-auto",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      title: "Auto work",
      autoApproveWrites: true,
    });

    const response = await postChat({
      conversationId: "conversation-write-auto",
      text: "Create a content element",
    });

    expect(response.status).toBe(200);
    await response.text();

    const assistant = await latestAssistantMessage("conversation-write-auto");
    expect(fakeMcp.toolCalls).toEqual([
      {
        name: "WriteTable",
        arguments: {
          table: "tt_content",
          data: { header: "Auto-approved headline" },
        },
      },
    ]);
    expect(assistant?.content).toBe("Auto-approved write completed.");
    expect(assistant?.tool_calls).not.toContain("approval-requested");
  });

  it("streams a tool-call response through a selected custom provider", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createToolCallResponse({
          toolCallId: "call-page-tree-custom",
          toolName: "GetPageTree",
          argumentsJson: "{}",
        }),
        createTextResponse({
          text: "Custom provider read the TYPO3 page tree.",
          usage: { inputTokens: 15, outputTokens: 6 },
        }),
      ],
      models: [{ id: "custom-chat", context_length: 4096 }],
    });
    await seedTokenModeConversation({
      conversationId: "conversation-custom-provider",
      fakeMcpUrl: fakeMcp.url,
      fakeModelUrl: fakeModel.url,
      customProvider: {
        id: "custom-one",
        displayName: "Custom One",
        remoteModelId: "custom-chat",
        apiKey: "custom-secret",
      },
    });

    const response = await postChat({
      conversationId: "conversation-custom-provider",
      text: "Read the page tree using custom provider",
    });

    expect(response.status).toBe(200);
    await response.text();

    const assistant = await latestAssistantMessage("conversation-custom-provider");
    const firstRequest = fakeModel.chatRequests[0] as {
      model?: string;
      tools?: unknown[];
    };

    expect(firstRequest.model).toBe("custom-chat");
    expect(firstRequest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: "GetPageTree" }),
        }),
      ]),
    );
    expect(fakeMcp.toolCalls).toEqual([
      { name: "GetPageTree", arguments: {} },
    ]);
    expect(assistant?.content).toBe("Custom provider read the TYPO3 page tree.");
  });
});

async function seedTokenModeConversation({
  conversationId,
  fakeMcpUrl,
  fakeModelUrl,
  customProvider,
  modelContextWindow = 4096,
  title = "New conversation",
  autoApproveWrites = false,
}: {
  conversationId: string;
  fakeMcpUrl: string;
  fakeModelUrl: string;
  autoApproveWrites?: boolean;
  customProvider?: {
    apiKey: string;
    displayName: string;
    id: string;
    remoteModelId: string;
  };
  modelContextWindow?: number | null;
  title?: string;
}) {
  vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
  vi.stubEnv("TYPO3_MCP_URL", fakeMcpUrl);
  vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "test-mcp-token");

  await db.insert(users).values({
    id: LOCAL_USER_ID,
    typo3_uid: LOCAL_USER_ID,
    display_name: "Local Test Editor",
  });
  await db.insert(conversations).values({
    id: conversationId,
    user_id: LOCAL_USER_ID,
    title,
    auto_approve_writes: autoApproveWrites ? 1 : 0,
  });
  await db.insert(userSettings).values({
    user_id: LOCAL_USER_ID,
    model_id: customProvider
      ? `custom:${customProvider.id}:${customProvider.remoteModelId}`
      : "fake-typo3-model",
    model_context_window: modelContextWindow,
    lmstudio_model_id: customProvider ? null : "fake-typo3-model",
    lmstudio_base_url: customProvider ? null : fakeModelUrl,
    custom_providers: customProvider
      ? JSON.stringify([
          {
            id: customProvider.id,
            displayName: customProvider.displayName,
            baseUrl: fakeModelUrl,
            apiKey: encrypt(customProvider.apiKey),
          },
        ])
      : null,
  });
}

async function persistedUiMessages(
  conversationId: string,
  updatePart?: (part: UIMessage["parts"][number]) => UIMessage["parts"][number],
): Promise<UIMessage[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  return rows.map((message) => ({
    id: message.id,
    role: message.role as UIMessage["role"],
    parts: (deserializeMessageParts(message.tool_calls) ?? [
      { type: "text", text: message.content },
    ]).map((part) => (updatePart ? updatePart(part) : part)),
  }));
}

async function postChatMessages({
  conversationId,
  messageId,
  messages: uiMessages,
}: {
  conversationId: string;
  messageId?: string;
  messages: UIMessage[];
}) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        messageId,
        messages: uiMessages,
      }),
    }) as never,
  );
}

async function postChat({
  conversationId,
  text,
}: {
  conversationId: string;
  text: string;
}) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
      }),
    }) as never,
  );
}

async function latestAssistantMessage(conversationId: string) {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversation_id, conversationId),
    orderBy: [asc(messages.created_at)],
  });

  return rows.findLast((message) => message.role === "assistant") ?? null;
}

async function expectConversationTitle(
  conversationId: string,
  expectedTitle: string,
) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    if (conversation?.title === expectedTitle) {
      expect(conversation.title).toBe(expectedTitle);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  expect(conversation?.title).toBe(expectedTitle);
}
