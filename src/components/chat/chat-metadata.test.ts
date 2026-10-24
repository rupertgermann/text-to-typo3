import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type DependencyList, type EffectCallback, type ReactNode, type SetStateAction } from "react";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatOnFinishCallback, type UIMessage } from "ai";
import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { ChatInterface } from "./ChatInterface";
import { POST } from "@/app/api/chat/route";
import { PATCH } from "@/app/api/conversations/[id]/route";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { conversations, messages, users, userSettings, type Conversation } from "@/lib/db/schema";
import { deferred } from "@/test/deferred";
import { tryAcquireConversation } from "@/lib/conversation-admission";
import { resetMcpCachesForTests } from "@/lib/mcp";
import { startFakeMcpServer, type FakeMcpServer } from "@/test/fake-mcp-server";
import { createTextResponse, startFakeOpenAICompatibleServer, type FakeOpenAICompatibleServer } from "@/test/fake-openai-compatible-server";

type HookState = {
  states: unknown[];
  effects: Array<{ deps?: DependencyList; cleanup: ReturnType<EffectCallback> }>;
  pending: Array<() => void>;
  cursor: number;
  dirty: boolean;
};
const hooks = vi.hoisted(() => ({
  current: null as HookState | null,
  chat: null as Chat<UIMessage> | null,
  onFinish: undefined as ChatOnFinishCallback<UIMessage> | undefined,
  onError: undefined as ((error: Error) => void) | undefined,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState<T,>(initial: T | (() => T)) {
    const state = hooks.current!;
    const index = state.cursor++;
    if (!(index in state.states)) state.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [state.states[index], (next: SetStateAction<T>) => {
      const value = typeof next === "function" ? (next as (value: T) => T)(state.states[index] as T) : next;
      state.dirty ||= !Object.is(value, state.states[index]);
      state.states[index] = value;
    }];
  },
  useRef(initial: unknown) {
    const state = hooks.current!;
    const index = state.cursor++;
    if (!(index in state.states)) state.states[index] = { current: initial };
    return state.states[index];
  },
  useMemo: (calculate: () => unknown) => calculate(),
  useCallback(callback: unknown, deps: DependencyList) {
    const state = hooks.current!;
    const index = state.cursor++;
    const old = state.states[index] as { callback: unknown; deps: DependencyList } | undefined;
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) state.states[index] = { callback, deps };
    return (state.states[index] as { callback: unknown }).callback;
  },
  useLayoutEffect() {},
  useEffect(effect: EffectCallback, deps?: DependencyList) {
    const state = hooks.current!;
    const index = state.cursor++;
    const old = state.effects[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      state.pending.push(() => {
        old?.cleanup?.();
        state.effects[index] = { deps, cleanup: effect() };
      });
    }
  },
}));
vi.mock("@ai-sdk/react", async (original) => ({
  ...await original<typeof import("@ai-sdk/react")>(),
  useChat(options: { onFinish?: ChatOnFinishCallback<UIMessage>; onError?: (error: Error) => void }) {
    hooks.onFinish = options.onFinish;
    hooks.onError = options.onError;
    const chat = hooks.chat!;
    return { messages: chat.messages, status: chat.status, error: chat.error, sendMessage: chat.sendMessage, regenerate: chat.regenerate, stop: chat.stop, clearError: chat.clearError, addToolApprovalResponse: chat.addToolApprovalResponse, setMessages: (messages: UIMessage[]) => { chat.messages = messages; } };
  },
}));

type Props = {
  children?: ReactNode;
  conversations?: Conversation[];
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => Promise<void>;
};
function elements(node: ReactNode): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function mount(component: () => ReactNode) {
  const state: HookState = { states: [], effects: [], pending: [], cursor: 0, dirty: false };
  return {
    draw() {
      for (let attempt = 0; attempt < 30; attempt++) {
        hooks.current = state;
        state.cursor = 0;
        state.dirty = false;
        const result = elements(component());
        state.pending.splice(0).forEach((effect) => effect());
        if (!state.dirty) return result;
      }
      throw new Error("Render loop");
    },
    cleanup() { state.effects.forEach((effect) => effect?.cleanup?.()); },
  };
}

let database: TestDatabase;
let fakeMcp: FakeMcpServer;
let fakeModel: FakeOpenAICompatibleServer;
const mounted: ReturnType<typeof mount>[] = [];
beforeEach(async () => {
  database = setupTestDatabase();
  fakeMcp = await startFakeMcpServer();
  fakeModel = await startFakeOpenAICompatibleServer({ chatResponses: [
    createTextResponse({ text: "Found three draft pages" }),
    createTextResponse({ text: "Generated draft page inventory" }),
  ] });
  vi.stubEnv("SESSION_SECRET", "complex_password_at_least_32_characters_long");
  vi.stubEnv("ENCRYPTION_KEY", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
  vi.stubEnv("TYPO3_MCP_URL", fakeMcp.url);
  vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", "test-mcp-token");
  vi.stubGlobal("window", new EventTarget());
  await db.insert(users).values({ id: "local-token-user", typo3_uid: "local-token-user", display_name: "Test" });
  await db.insert(userSettings).values({ user_id: "local-token-user", model_id: "fake-typo3-model", lmstudio_model_id: "fake-typo3-model", lmstudio_base_url: fakeModel.url });
  await db.insert(conversations).values([
    { id: "metadata", user_id: "local-token-user", title: "New conversation", updated_at: 1 },
    { id: "other", user_id: "local-token-user", title: "Other conversation", updated_at: 2 },
  ]);
});
afterEach(async () => {
  mounted.splice(0).forEach((component) => component.cleanup());
  await fakeModel.close();
  await fakeMcp.close();
  resetMcpCachesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  database.cleanup();
});

it.each(["generated", "manual rename", "rejected", "timeout"])("refreshes a mounted sidebar after deferred title %s and releases the persistence lease", async (mode) => {
  const enteredTitle = deferred<void>();
  const resumeTitle = deferred<void>();
  const timedOut = new AbortController();
  const realTimeout = AbortSignal.timeout;
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) =>
    mode === "timeout" && milliseconds === 5000 ? timedOut.signal : realTimeout(milliseconds),
  );
  const realFetch = globalThis.fetch;
  let listReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/conversations") {
      listReads++;
      return Response.json(await db.select().from(conversations).orderBy(desc(conversations.updated_at)));
    }
    if (String(input).startsWith(fakeModel.url) && typeof init?.body === "string" && !JSON.parse(init.body).stream) {
      enteredTitle.resolve();
      if (mode === "timeout") {
        await new Promise<void>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      } else {
        await resumeTitle.promise;
        if (mode === "rejected") throw new Error("Title provider unavailable");
      }
    }
    return realFetch(input, init);
  });
  const sidebar = mount(() => ConversationSidebar({ activeConversationId: "metadata" }));
  mounted.push(sidebar);
  const shown = () => sidebar.draw().find((node) => node.props.conversations)?.props.conversations ?? [];
  await vi.waitFor(() => expect(shown().map((row) => row.title)).toEqual(["Other conversation", "New conversation"]));
  hooks.chat = new Chat<UIMessage>({
    onFinish: (info) => hooks.onFinish?.(info),
    onError: (error) => hooks.onError?.(error),
    transport: new DefaultChatTransport({
      body: { conversationId: "metadata" },
      fetch: async (_, init) => POST(new NextRequest("http://localhost/api/chat", { ...init, signal: init?.signal ?? undefined })),
    }),
  });
  const chat = mount(() => ChatInterface({ initialAutoApproveWrites: false, conversationId: "metadata", initialMessages: [], typo3BaseUrl: "https://typo3.example.test" }));
  mounted.push(chat);
  chat.draw().find((node) => node.type === "textarea")!.props.onChange!({ target: { value: "Find all draft pages" } });
  const sending = chat.draw().find((node) => node.type === "form")!.props.onSubmit!({ preventDefault() {} });
  let finished = false;
  void sending.then(() => { finished = true; });
  await enteredTitle.promise;
  await vi.waitFor(async () => expect((await db.select().from(messages)).some((row) => row.content === "Found three draft pages")).toBe(true));
  expect(finished).toBe(false);
  expect(shown().find((row) => row.id === "metadata")?.title).toBe("New conversation");
  const nextLease = tryAcquireConversation("local-token-user", "metadata");
  expect(nextLease).not.toBeNull();
  nextLease?.();
  if (mode === "manual rename") {
    const response = await PATCH(new NextRequest("http://localhost/api/conversations/metadata", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "My chosen title" }),
    }), { params: Promise.resolve({ id: "metadata" }) });
    expect(response.ok).toBe(true);
  }
  const retainedLease = tryAcquireConversation("local-token-user", "metadata");
  expect(retainedLease).not.toBeNull();
  try {
    if (mode === "timeout") timedOut.abort(new DOMException("Title timed out", "TimeoutError"));
    else resumeTitle.resolve();
    await sending;
    const title = mode === "generated" ? "Generated draft page inventory" : mode === "manual rename" ? "My chosen title" : "Find all draft pages";
    await vi.waitFor(() => expect(shown()[0]).toMatchObject({ id: "metadata", title }));
    const saved = await db.query.conversations.findFirst({ where: eq(conversations.id, "metadata") });
    expect(shown()[0].updated_at).toBe(saved?.updated_at);
    expect(shown()[0].updated_at).toBeGreaterThan(2);
    expect(listReads).toBe(2);
    expect(hooks.chat.status).toBe("ready");
    expect(hooks.chat.error).toBeUndefined();
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    expect(tryAcquireConversation("local-token-user", "metadata")).toBeNull();
  } finally {
    retainedLease?.();
    resumeTitle.resolve();
  }
});
