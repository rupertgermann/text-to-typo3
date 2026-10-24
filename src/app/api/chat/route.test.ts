import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { Chat } from "@ai-sdk/react";
import { POST } from "./route";
import { GET as exportConversation } from "../conversations/[id]/export/route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { conversations, messages, userSettings, users } from "@/lib/db/schema";
import { deserializeMessageParts } from "@/lib/chat-message-parts";
import { encrypt } from "@/lib/crypto";
import * as chatPersistence from "@/lib/chat-turn-persistence";
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it.each(["new", "edit", "regenerate"])("preserves completed mutations after a failed %s turn and refuses destructive replay", async (kind) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [
      createToolCallResponse({ toolCallId: "completed-write", toolName: "WriteTable", argumentsJson: JSON.stringify({ action: "create", table: "pages", data: { title: "Created" } }) }),
      { chunks: [{ error: { message: "Later model failure", type: "server_error", code: "server_error" } }] },
    ] });
    await seedTokenModeConversation({ conversationId: "failed-write", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Writes", autoApproveWrites: true });
    if (kind !== "new") await db.insert(messages).values({ id: "write-user", conversation_id: "failed-write", role: "user", content: "Create a page", created_at: 1 });
    if (kind !== "new") await db.insert(messages).values({ id: "old-answer", conversation_id: "failed-write", role: "assistant", content: "Original answer", created_at: 2 });
    const before = await persistedUiMessages("failed-write");
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "failed-write", trigger: kind === "regenerate" ? "regenerate-message" : "submit-message", messageId: kind === "new" ? undefined : kind === "regenerate" ? "old-answer" : "write-user", messages: kind === "new" ? [{ id: "write-user", role: "user", parts: [{ type: "text", text: "Create a page" }] }] : kind === "edit" ? [{ ...before[0], parts: [{ type: "text", text: "Changed question" }] }] : before }),
    }) as never);
    expect(await response.text()).toContain('"type":"error"');
    const saved = await persistedUiMessages("failed-write");
    expect(saved.slice(0, before.length)).toEqual(before);
    expect(saved.at(-1)?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "completed-write", state: "output-available" })]));
    const reloaded = new Chat({ messages: saved, transport: new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "failed-write" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) }) });
    await reloaded.sendMessage({ messageId: "write-user", parts: saved[0].parts });
    expect(reloaded.error?.message).toContain("new message");
    expect(await persistedUiMessages("failed-write")).toEqual(saved);
    const regenerate = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "failed-write", trigger: "regenerate-message", messageId: saved.at(-1)?.id, messages: saved }) }) as never);
    expect(regenerate.status).toBe(409);
    expect(await regenerate.text()).toContain("new message");
    expect(fakeMcp.toolCalls).toHaveLength(1);
  });

  it("rejects an overlapping submission before inserting it and permits other conversations", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "Answer" }), createTextResponse({ text: "Other answer" }), createTextResponse({ text: "Later answer" })] });
    await seedTokenModeConversation({ conversationId: "busy", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Busy" });
    await db.insert(conversations).values({ id: "independent", user_id: LOCAL_USER_ID, title: "Independent" });
    const responses = await Promise.all([postChat({ conversationId: "busy", text: "ALPHA" }), postChat({ conversationId: "busy", text: "BETA" }), postChat({ conversationId: "independent", text: "GAMMA" })]);
    expect(responses.map((response) => response.status)).toEqual([200, 409, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect((await persistedUiMessages("busy")).filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(fakeModel.chatRequests)).not.toContain("BETA");
    const later = await postChat({ conversationId: "busy", text: "DELTA" });
    expect(later.status).toBe(200);
    await later.text();
  });

  it("retains partial text after provider failure", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [{ chunks: [...createTextResponse({ text: "Partial answer" }).chunks.slice(0, 1), { error: { message: "Later failure", type: "server_error", code: "server_error" } }] }] });
    await seedTokenModeConversation({ conversationId: "partial", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Partial" });
    const response = await postChat({ conversationId: "partial", text: "Question" });
    await response.text();
    expect((await latestAssistantMessage("partial"))?.content).toBe("Partial answer");
  });

  it.each(["reload approval", "mixed read approval", "denial"])("persists built-in MCP %s through the SDK and export", async (mode) => {
    const includeRead = mode === "mixed read approval";
    const approved = mode !== "denial";
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [] });
    await seedTokenModeConversation({ conversationId: "dynamic", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Dynamic" });
    await db.update(userSettings).set({ model_id: "gpt-5.4-nano", lmstudio_model_id: null, lmstudio_base_url: null });
    vi.stubEnv("OPENAI_API_KEY", "synthetic");
    const realFetch = globalThis.fetch;
    const providerRequests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith("https://api.openai.com/")) return realFetch(input, init);
      providerRequests.push(String(init?.body));
      const item = providerRequests.length === 1
        ? { type: "mcp_approval_request", id: "approval-item", server_label: "typo3", name: "WriteTable", arguments: JSON.stringify({ action: "create", table: "pages", data: { title: "Created" } }) }
        : { type: "mcp_call", status: "completed", id: "completed-item", approval_request_id: "approval-item", server_label: "typo3", name: "WriteTable", arguments: JSON.stringify({ action: "create", table: "pages", data: { title: "Created" } }), output: JSON.stringify({ uid: 123 }), error: null };
      const events = [
        { type: "response.created", response: { id: "resp_test", created_at: 1, model: "gpt-5.4-nano" } },
        ...(includeRead && providerRequests.length === 1 ? [
          { type: "response.output_item.done", output_index: 0, item: { type: "mcp_call", status: "completed", id: "completed-read", server_label: "typo3", name: "GetPageTree", arguments: "{}", output: JSON.stringify({ title: "Home" }), error: null } },
        ] : []),
        ...(approved || providerRequests.length === 1 ? [
          { type: "response.output_item.added", output_index: 1, item },
          { type: "response.output_item.done", output_index: 1, item },
        ] : []),
        { type: "response.completed", response: { id: "resp_test", usage: { input_tokens: 10, output_tokens: 10 }, incomplete_details: null } },
      ];
      return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    });
    const transport = new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "dynamic" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) });
    const chat = new Chat({ transport });
    await chat.sendMessage({ text: "Create a page" });
    expect(chat.error).toBeUndefined();
    const pending = await persistedUiMessages("dynamic");
    expect(pending.at(-1)?.id).toBe(chat.lastMessage?.id);
    expect(pending.at(-1)?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dynamic-tool", state: "approval-requested" })]));
    const reloaded = includeRead ? chat : new Chat({ transport, messages: pending });
    await reloaded.addToolApprovalResponse({ id: "approval-item", approved });
    await reloaded.sendMessage();
    expect(reloaded.error).toBeUndefined();
    const completed = await persistedUiMessages("dynamic");
    expect(completed).toHaveLength(2);
    expect(completed.at(-1)?.id).toBe(pending.at(-1)?.id);
    expect(providerRequests[1]).toContain(`"approve":${approved}`);
    if (!approved) {
      expect(completed.at(-1)?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dynamic-tool", approval: { id: "approval-item", approved: false } })]));
      expect(completed.at(-1)?.parts.some((part) => isToolUIPart(part) && part.state === "output-available")).toBe(false);
      return;
    }
    expect(completed.at(-1)?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dynamic-tool", state: "output-available", output: expect.objectContaining({ name: "WriteTable" }) })]));
    const exported = await exportConversation(new Request("http://localhost/api/conversations/dynamic/export") as never, { params: Promise.resolve({ id: "dynamic" }) });
    const markdown = await exported.text();
    expect(markdown).toContain("WriteTable");
    expect(markdown).toContain("123");
    await reloaded.sendMessage({ messageId: completed[0].id, parts: completed[0].parts });
    expect(reloaded.error?.message).toContain("new message");
    expect(providerRequests).toHaveLength(2);
    expect(await persistedUiMessages("dynamic")).toEqual(completed);
  });

  it.each(["edit", "regenerate"])("allows %s after a completed read-only tool", async (kind) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createToolCallResponse({ toolCallId: "read", toolName: "GetPageTree", argumentsJson: "{}" }), createTextResponse({ text: "Read complete" }), createTextResponse({ text: "Replacement" })] });
    await seedTokenModeConversation({ conversationId: "readonly", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Read" });
    const chat = new Chat({ transport: new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "readonly" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) }) });
    await chat.sendMessage({ text: "Read the page tree" });
    expect(chat.error).toBeUndefined();
    if (kind === "edit") await chat.sendMessage({ messageId: chat.messages[0].id, text: "Read it differently" });
    else await chat.regenerate({ messageId: chat.lastMessage?.id });
    expect(chat.error).toBeUndefined();
    expect((await latestAssistantMessage("readonly"))?.content).toBe("Replacement");
  });

  it("regenerates appended partial text without overwriting the retained original assistant", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [
      { chunks: [...createTextResponse({ text: "Partial replacement" }).chunks.slice(0, 1), { error: { message: "Later failure", type: "server_error", code: "server_error" } }] },
      createTextResponse({ text: "Complete replacement" }),
    ] });
    await seedTokenModeConversation({ conversationId: "partial-replacement", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Partial" });
    await db.insert(messages).values([
      { id: "partial-user", conversation_id: "partial-replacement", role: "user", content: "Original question", created_at: 1 },
      { id: "original-assistant", conversation_id: "partial-replacement", role: "assistant", content: "Original answer", created_at: 2 },
    ]);
    const transport = new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "partial-replacement" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) });
    const chat = new Chat({ messages: await persistedUiMessages("partial-replacement"), transport });
    await chat.sendMessage({ messageId: "partial-user", text: "Edited question" });
    expect(chat.error).toBeDefined();
    await vi.waitFor(async () => expect(await persistedUiMessages("partial-replacement")).toHaveLength(3));
    const saved = await persistedUiMessages("partial-replacement");
    expect(saved).toHaveLength(3);
    const reloaded = new Chat({ messages: saved, transport });
    await reloaded.regenerate({ messageId: saved.at(-1)?.id });
    expect(reloaded.error).toBeUndefined();
    const completed = await persistedUiMessages("partial-replacement");
    expect(completed).toHaveLength(3);
    expect(completed[1]).toEqual(saved[1]);
    expect(completed.at(-1)?.id).toBe(reloaded.lastMessage?.id);
    expect(completed.at(-1)?.parts).toEqual(expect.arrayContaining([{ type: "text", text: "Complete replacement", state: "done" }]));
  });

  it.each([false, true])("holds the conversation through persistence and releases when persistence throws=%s", async (throws) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "First" }), createTextResponse({ text: "Later" })] });
    await seedTokenModeConversation({ conversationId: "persist-lock", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Lock" });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const persist = chatPersistence.persistResponseMessage;
    vi.spyOn(chatPersistence, "persistResponseMessage").mockImplementationOnce(async (input) => {
      entered.resolve();
      await resume.promise;
      if (throws) throw new Error("Persistence failed");
      return persist(input);
    });
    const first = await postChat({ conversationId: "persist-lock", text: "First" });
    const finished = first.text().catch((error: unknown) => error);
    await entered.promise;
    const overlap = await postChat({ conversationId: "persist-lock", text: "Rejected" });
    expect(overlap.status).toBe(409);
    resume.resolve();
    await finished;
    const later = await postChat({ conversationId: "persist-lock", text: "Later" });
    expect(later.status).toBe(200);
    await later.text();
    expect((await persistedUiMessages("persist-lock")).filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("persists the response and releases its conversation when the client cancels the stream", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "Completed in background" }), createTextResponse({ text: "Later" })] });
    await seedTokenModeConversation({ conversationId: "abort-lock", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Abort" });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const realFetch = globalThis.fetch;
    let intercept = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions") && intercept) {
        intercept = false;
        entered.resolve();
        await resume.promise;
      }
      return realFetch(input, init);
    });
    const response = await postChat({ conversationId: "abort-lock", text: "First" });
    await entered.promise;
    const cancelled = response.body?.cancel();
    expect((await postChat({ conversationId: "abort-lock", text: "While finishing" })).status).toBe(409);
    resume.resolve();
    await cancelled;
    await vi.waitFor(async () => expect((await latestAssistantMessage("abort-lock"))?.content).toBe("Completed in background"));
    const later = await postChat({ conversationId: "abort-lock", text: "Later" });
    expect(later.status).toBe(200);
    await later.text();
  });

  it("retains edited image parts through the API and reload, including explicit replacement", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "Revised answer" }), createTextResponse({ text: "New image answer" })] });
    await seedTokenModeConversation({ conversationId: "edit-images", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Images" });
    const originalImage = { type: "file", mediaType: "image/png", filename: "original.png", url: "data:image/png;base64,aW1hZ2U=" } satisfies UIMessage["parts"][number];
    const newImage = { ...originalImage, filename: "replacement.png", url: "data:image/png;base64,bmV3" };
    await db.insert(messages).values({ id: "image-user", conversation_id: "edit-images", role: "user", content: "Original question", tool_calls: JSON.stringify([{ type: "text", text: "Original question" }, originalImage]) });
    const transport = new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "edit-images" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) });
    const chat = new Chat({ transport, messages: await persistedUiMessages("edit-images") });
    await chat.sendMessage({ messageId: "image-user", parts: [{ type: "text", text: "Revised question" }, originalImage] });
    expect(chat.error).toBeUndefined();
    const saved = await persistedUiMessages("edit-images");
    expect(saved[0].parts).toEqual([{ type: "text", text: "Revised question" }, originalImage]);
    const reloaded = new Chat({ transport, messages: saved });
    await reloaded.sendMessage({ messageId: "image-user", parts: [newImage] });
    expect(reloaded.error).toBeUndefined();
    expect((await persistedUiMessages("edit-images"))[0].parts).toEqual([newImage]);
  });

  it("keeps SDK message IDs through send, edit, regenerate and approval without reloading", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({
      chatResponses: [
        createTextResponse({ text: "First answer" }),
        createTextResponse({ text: "Edited answer" }),
        createTextResponse({ text: "Regenerated answer" }),
        createToolCallResponse({ toolCallId: "sdk-write", toolName: "WriteTable", argumentsJson: JSON.stringify({ table: "pages", data: { title: "Approved" } }) }),
        createTextResponse({ text: "Write complete" }),
      ],
    });
    await seedTokenModeConversation({ conversationId: "sdk", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "SDK" });
    const chat = new Chat({
      transport: new DefaultChatTransport({
        api: "http://localhost/api/chat",
        body: { conversationId: "sdk" },
        fetch: async (input, init) => POST(new Request(String(input), init) as never),
      }),
    });
    const expectStoredIds = async () => {
      expect(chat.error).toBeUndefined();
      const stored = await persistedUiMessages("sdk");
      expect(chat.messages.map((message) => message.id)).toEqual(stored.map((message) => message.id));
    };
    await chat.sendMessage({ text: "First question" });
    await expectStoredIds();
    await chat.sendMessage({ messageId: chat.messages[0].id, text: "Edited question" });
    await expectStoredIds();
    await chat.regenerate({ messageId: chat.lastMessage?.id });
    await expectStoredIds();
    expect(JSON.stringify(fakeModel.chatRequests[2])).not.toContain("Edited answer");
    await chat.sendMessage({ text: "Create a page" });
    await expectStoredIds();
    const pending = chat.lastMessage?.parts.find((part) => isToolUIPart(part) && part.state === "approval-requested");
    if (!pending || !isToolUIPart(pending) || pending.state !== "approval-requested") throw new Error("Expected pending approval");
    const assistantId = chat.lastMessage?.id;
    await chat.addToolApprovalResponse({ id: pending.approval.id, approved: true });
    await chat.sendMessage();
    await expectStoredIds();
    expect(chat.lastMessage?.id).toBe(assistantId);
    expect(fakeMcp.toolCalls).toEqual([{ name: "WriteTable", arguments: { table: "pages", data: { title: "Approved" } } }]);
  });

  it.each(["provider setup", "MCP setup", "provider stream"])("retains regeneration and edit history after %s failure", async (failure) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [], chatStatus: 500 });
    await seedTokenModeConversation({ conversationId: "retained", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Keep history" });
    await db.insert(messages).values([
      { id: "keep-user", conversation_id: "retained", role: "user", content: "Original question", created_at: 1 },
      { id: "keep-assistant", conversation_id: "retained", role: "assistant", content: "Original answer", created_at: 2 },
    ]);
    if (failure === "provider setup") {
      vi.stubEnv("OPENAI_API_KEY", "");
      await db.update(userSettings).set({ model_id: "gpt-4o", lmstudio_model_id: null, lmstudio_base_url: null }).where(eq(userSettings.user_id, LOCAL_USER_ID));
    }
    if (failure === "MCP setup") vi.stubEnv("TYPO3_MCP_URL", `${fakeModel.url}/missing`);
    const before = await persistedUiMessages("retained");
    for (const trigger of ["regenerate-message", "submit-message"]) {
      const response = await POST(new Request("http://localhost/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "retained", trigger, messageId: trigger === "regenerate-message" ? "keep-assistant" : "keep-user", messages: trigger === "regenerate-message" ? before : [{ ...before[0], parts: [{ type: "text", text: "Changed question" }] }] }),
      }) as never);
      await response.text();
      expect(await persistedUiMessages("retained")).toEqual(before);
    }
  });

  it.each([false, true])("claims an approval once across concurrent requests and later provider failure=%s", async (providerFails) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [providerFails ? { chunks: [{ error: { message: "Provider failed", type: "server_error", code: "server_error" } }] } : createTextResponse({ text: "Write complete" }), createTextResponse({ text: "Next answer" })] });
    await seedTokenModeConversation({ conversationId: "approval-race", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Approval" });
    const pending = { type: "tool-WriteTable", toolCallId: "race-call", state: "approval-requested", input: { table: "pages", data: { title: "Approved" } }, approval: { id: "race-approval" } } satisfies UIMessage["parts"][number];
    await db.insert(messages).values([
      { id: "race-user", conversation_id: "approval-race", role: "user", content: "Create a page", created_at: 1 },
      { id: "race-assistant", conversation_id: "approval-race", role: "assistant", content: "", tool_calls: JSON.stringify([pending]), created_at: 2 },
    ]);
    const responded = await persistedUiMessages("approval-race", (part) => isToolUIPart(part) && part.state === "approval-requested" ? { ...part, state: "approval-responded", approval: { id: part.approval.id, approved: true } } : part);
    const request = () => postChatMessages({ conversationId: "approval-race", messageId: "race-assistant", messages: responded });
    const responses = await Promise.all([request(), request()]);
    await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const completed = await latestAssistantMessage("approval-race");
    expect(deserializeMessageParts(completed?.tool_calls)).toEqual(expect.arrayContaining([expect.objectContaining({ toolCallId: "race-call", state: "output-available" })]));
    const replay = await request();
    await replay.text();
    expect(replay.status).toBe(400);
    const next = await postChat({ conversationId: "approval-race", text: "What next?" });
    await next.text();
    expect(fakeMcp.toolCalls).toHaveLength(1);
  });

  it.each(["approval ID", "tool call ID", "input", "tool name", "prior output"])("rejects approval changes to %s", async (field) => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [] });
    await seedTokenModeConversation({ conversationId: "approval-tamper", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Approval" });
    const pending = { type: "tool-WriteTable", toolCallId: "pending-call", state: "approval-requested", input: { table: "pages", data: { title: "Approved" } }, approval: { id: "pending-approval" } } satisfies UIMessage["parts"][number];
    const completed = { type: "tool-GetPageTree", toolCallId: "read-call", state: "output-available", input: {}, output: { title: "Real output" } } satisfies UIMessage["parts"][number];
    await db.insert(messages).values([
      { id: "tamper-user", conversation_id: "approval-tamper", role: "user", content: "Create a page", created_at: 1 },
      { id: "tamper-assistant", conversation_id: "approval-tamper", role: "assistant", content: "", tool_calls: JSON.stringify([completed, pending]), created_at: 2 },
    ]);
    const before = await persistedUiMessages("approval-tamper");
    const responded = await persistedUiMessages("approval-tamper", (part) => {
      if (!isToolUIPart(part) || part.type === "dynamic-tool") return part;
      if (part.state === "output-available" && field === "prior output") return { ...part, output: { title: "Forged output" } };
      if (part.state !== "approval-requested") return part;
      return {
        ...part,
        type: field === "tool name" ? "tool-DeleteTable" : part.type,
        toolCallId: field === "tool call ID" ? "unknown-call" : part.toolCallId,
        input: field === "input" ? { table: "pages", data: { title: "Injected" } } : part.input,
        state: "approval-responded",
        approval: { id: field === "approval ID" ? "unknown-approval" : part.approval.id, approved: true },
      };
    });
    const response = await postChatMessages({ conversationId: "approval-tamper", messages: responded });
    expect(response.status).toBe(400);
    expect(await persistedUiMessages("approval-tamper")).toEqual(before);
    expect(fakeMcp.toolCalls).toEqual([]);
    expect(fakeModel.chatRequests).toEqual([]);
  });

  it("rejects incoming IDs owned by another conversation without changing it", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [] });
    await seedTokenModeConversation({ conversationId: "owned", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Owned" });
    await db.insert(users).values({ id: "other-user", typo3_uid: "other-user", display_name: "Other user" });
    await db.insert(conversations).values({ id: "foreign", user_id: "other-user", title: "Private" });
    await db.insert(messages).values({ id: "foreign-message", conversation_id: "foreign", role: "user", content: "Private original" });
    const before = await persistedUiMessages("foreign");
    const incoming: UIMessage[] = [{ id: "foreign-message", role: "user", parts: [{ type: "text", text: "Overwrite" }] }];
    expect((await postChatMessages({ conversationId: "owned", messages: incoming })).status).toBe(400);
    expect((await postChatMessages({ conversationId: "owned", messageId: "foreign-message", messages: incoming })).status).toBe(404);
    expect(await persistedUiMessages("foreign")).toEqual(before);
    expect(await persistedUiMessages("owned")).toEqual([]);
  });

  it("retries the initial SDK message after missing provider configuration is fixed", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "Retry succeeded" })] });
    await seedTokenModeConversation({ conversationId: "sdk-retry", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Retry" });
    vi.stubEnv("OPENAI_API_KEY", "");
    await db.update(userSettings).set({ model_id: "gpt-4o", lmstudio_model_id: null, lmstudio_base_url: null }).where(eq(userSettings.user_id, LOCAL_USER_ID));
    const chat = new Chat({ transport: new DefaultChatTransport({ api: "http://localhost/api/chat", body: { conversationId: "sdk-retry" }, fetch: async (input, init) => POST(new Request(String(input), init) as never) }) });
    await chat.sendMessage({ text: "First question" });
    expect(chat.error).toBeDefined();
    const [storedUser] = await persistedUiMessages("sdk-retry");
    expect(storedUser.id).toBe(chat.messages[0].id);
    await db.update(userSettings).set({ model_id: "fake-typo3-model", lmstudio_model_id: "fake-typo3-model", lmstudio_base_url: fakeModel.url }).where(eq(userSettings.user_id, LOCAL_USER_ID));
    await chat.sendMessage({ parts: chat.messages[0].parts, messageId: chat.messages[0].id });
    expect(chat.error).toBeUndefined();
    expect(chat.messages.map((message) => message.id)).toEqual((await persistedUiMessages("sdk-retry")).map((message) => message.id));
    expect(chat.messages).toHaveLength(2);
  });

  it("keeps an approval pending when provider setup fails", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [] });
    await seedTokenModeConversation({ conversationId: "approval-setup", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Approval" });
    const pending = { type: "tool-WriteTable", toolCallId: "setup-call", state: "approval-requested", input: { table: "pages", data: { title: "Approved" } }, approval: { id: "setup-approval" } } satisfies UIMessage["parts"][number];
    await db.insert(messages).values([
      { id: "setup-user", conversation_id: "approval-setup", role: "user", content: "Create a page", created_at: 1 },
      { id: "setup-assistant", conversation_id: "approval-setup", role: "assistant", content: "", tool_calls: JSON.stringify([pending]), created_at: 2 },
    ]);
    vi.stubEnv("OPENAI_API_KEY", "");
    await db.update(userSettings).set({ model_id: "gpt-4o", lmstudio_model_id: null, lmstudio_base_url: null }).where(eq(userSettings.user_id, LOCAL_USER_ID));
    const before = await persistedUiMessages("approval-setup");
    const responded = await persistedUiMessages("approval-setup", (part) => isToolUIPart(part) && part.state === "approval-requested" ? { ...part, state: "approval-responded", approval: { id: part.approval.id, approved: true } } : part);
    const response = await postChatMessages({ conversationId: "approval-setup", messages: responded });
    expect(response.status).toBe(400);
    expect(await persistedUiMessages("approval-setup")).toEqual(before);
  });

  it("commits only one replacement when two regenerations race", async () => {
    fakeMcp = await startFakeMcpServer();
    fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [createTextResponse({ text: "First replacement" }), createTextResponse({ text: "Second replacement" })] });
    await seedTokenModeConversation({ conversationId: "regen-race", fakeMcpUrl: fakeMcp.url, fakeModelUrl: fakeModel.url, title: "Regeneration" });
    await db.insert(messages).values([
      { id: "regen-race-user", conversation_id: "regen-race", role: "user", content: "Try again", created_at: 1 },
      { id: "regen-race-assistant", conversation_id: "regen-race", role: "assistant", content: "Original", created_at: 2 },
    ]);
    const history = await persistedUiMessages("regen-race");
    const request = () => POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "regen-race", trigger: "regenerate-message", messageId: "regen-race-assistant", messages: history }) }) as never);
    const responses = await Promise.all([request(), request()]);
    await Promise.allSettled(responses.map((response) => response.text()));
    expect((await persistedUiMessages("regen-race")).filter((message) => message.role === "assistant")).toHaveLength(1);
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
    expect(await response.text()).toContain("Model provider error");
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
