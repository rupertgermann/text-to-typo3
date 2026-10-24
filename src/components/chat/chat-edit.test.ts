import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type SetStateAction } from "react";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, createUIMessageStreamResponse, type ChatTransport, type ChatOnFinishCallback, type UIMessage, type UIMessageChunk } from "ai";
import { MessageBubble } from "./MessageBubble";
import { ChatInterface } from "./ChatInterface";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, chat: null as Chat<UIMessage> | null, onError: undefined as ((error: Error) => void) | undefined, onFinish: undefined as ChatOnFinishCallback<UIMessage> | undefined, initialError: undefined as Error | undefined }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState<T,>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [hooks.states[index], (next: SetStateAction<T>) => {
      hooks.states[index] = typeof next === "function" ? (next as (previous: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = { current: initial };
    return hooks.states[index];
  },
  useMemo: (calculate: () => unknown) => calculate(),
  useCallback: (callback: unknown) => callback,
  useLayoutEffect() {},
}));
vi.mock("@ai-sdk/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-sdk/react")>(),
  useChat: (options: { onError?: (error: Error) => void; onFinish?: ChatOnFinishCallback<UIMessage> }) => {
    hooks.onError = options.onError;
    hooks.onFinish = options.onFinish;
    const chat = hooks.chat;
    if (!chat) throw new Error("Chat fixture is missing");
    return { messages: chat.messages, status: chat.status, error: chat.error ?? hooks.initialError, sendMessage: chat.sendMessage, regenerate: chat.regenerate, stop: chat.stop, clearError: chat.clearError, addToolApprovalResponse: chat.addToolApprovalResponse, setMessages: (messages: UIMessage[]) => { chat.messages = messages; } };
  },
}));

type TestProps = {
  children?: ReactNode;
  message?: UIMessage;
  title?: string;
  value?: string;
  disabled?: boolean;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  onKeyDown?: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => void;
  onEdit?: () => void;
  onRegenerate?: () => Promise<void>;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onDrop?: (event: { preventDefault(): void; dataTransfer: { files: File[] } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => Promise<void>;
};
function elements(node: ReactNode): React.ReactElement<TestProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<TestProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function draw() {
  hooks.cursor = 0;
  return elements(ChatInterface({ initialAutoApproveWrites: false, conversationId: "edit", initialMessages: [], typo3BaseUrl: "https://typo3.example" }));
}
const originalImage = { type: "file", mediaType: "image/png", filename: "page.png", url: "data:image/png;base64,aW1hZ2U=" } satisfies UIMessage["parts"][number];
beforeEach(() => { hooks.states = []; hooks.initialError = undefined; hooks.onError = undefined; });
afterEach(() => { vi.unstubAllGlobals(); });

it.each([false, true])("retains original image parts when editing image-only=%s messages through the SDK", async (imageOnly) => {
  const original: UIMessage = { id: "original-user", role: "user", parts: [...(imageOnly ? [] : [{ type: "text" as const, text: "Inspect this image" }]), originalImage] };
  const requests: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0][] = [];
  hooks.chat = new Chat<UIMessage>({ messages: [original], transport: {
    sendMessages: async (request) => { requests.push(request); return new ReadableStream({ start(controller) { controller.close(); } }); },
    reconnectToStream: async () => null,
  } });
  draw().find((node) => node.props.message?.id === original.id)?.props.onEdit?.();
  let tree = draw();
  expect(tree.some((node) => node.props.children === "page.png")).toBe(true);
  if (!imageOnly) tree.find((node) => node.type === "textarea")?.props.onChange?.({ target: { value: "Inspect the page header" } });
  tree = draw();
  await tree.find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[0]).toMatchObject({ id: original.id, parts: [...(imageOnly ? [] : [{ type: "text", text: "Inspect the page header" }]), originalImage] });
  expect(hooks.chat.messages[0].parts.filter((part) => part.type === "file")).toEqual([originalImage]);
});

it("removes an original attachment only when its remove button is used", async () => {
  hooks.chat = new Chat<UIMessage>({ messages: [{ id: "original-user", role: "user", parts: [{ type: "text", text: "Keep text" }, originalImage] }], transport: {
    sendMessages: async () => new ReadableStream({ start(controller) { controller.close(); } }),
    reconnectToStream: async () => null,
  } });
  draw().find((node) => node.props.message?.id === "original-user")?.props.onEdit?.();
  draw().find((node) => node.props.title === "Remove attachment")?.props.onClick?.();
  await draw().find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  expect(hooks.chat.messages[0].parts).toEqual([{ type: "text", text: "Keep text" }]);
});

it("submits existing and newly attached images together when editing", async () => {
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,bmV3";
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  });
  hooks.chat = new Chat<UIMessage>({ messages: [{ id: "original-user", role: "user", parts: [{ type: "text", text: "Inspect both" }, originalImage] }], transport: {
    sendMessages: async () => new ReadableStream({ start(controller) { controller.close(); } }),
    reconnectToStream: async () => null,
  } });
  draw().find((node) => node.props.message?.id === "original-user")?.props.onEdit?.();
  draw().find((node) => node.props.onDrop)?.props.onDrop?.({ preventDefault() {}, dataTransfer: { files: [new File(["new"], "new.png", { type: "image/png" })] } });
  await draw().find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  expect(hooks.chat.messages[0].parts).toEqual([{ type: "text", text: "Inspect both" }, originalImage, { type: "file", mediaType: "image/png", filename: "new.png", url: "data:image/png;base64,bmV3" }]);
});

it.each(["edit", "regenerate", "retry"])("restores visible tool evidence when the server refuses %s", async (action) => {
  const history: UIMessage[] = [
    { id: "original-user", role: "user", parts: [{ type: "text", text: "Create a page" }] },
    { id: "completed-assistant", role: "assistant", parts: [{ type: "tool-WriteTable", toolCallId: "completed-write", state: "output-available", input: {}, output: { uid: 123, _meta: { operation: "write" } } }] },
  ];
  hooks.chat = new Chat<UIMessage>({ messages: history, onError: (error) => hooks.onError?.(error), transport: {
    sendMessages: async () => { throw new Error(JSON.stringify({ error: { code: "completed_tool_results", message: "Continue with a new message" } })); },
    reconnectToStream: async () => null,
  } });
  if (action === "edit") {
    draw().find((node) => node.props.message?.id === "original-user")?.props.onEdit?.();
    await draw().find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  } else if (action === "regenerate") {
    await draw().find((node) => node.props.message?.id === "completed-assistant")?.props.onRegenerate?.();
  } else {
    hooks.initialError = new Error("Provider failed after the completed write");
    draw().find((node) => Array.isArray(node.props.children) && node.props.children.includes("Retry"))?.props.onClick?.();
  }
  await vi.waitFor(() => expect(hooks.chat?.error?.message).toContain("completed_tool_results"));
  expect(hooks.chat.messages).toEqual(history);
  expect(draw().some((node) => node.props.message?.id === "completed-assistant")).toBe(true);
});

it("restores a busy submission to the composer so Send submits a fresh user message", async () => {
  const requests: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0][] = [];
  hooks.chat = new Chat<UIMessage>({ onError: (error) => hooks.onError?.(error), transport: {
    sendMessages: async (request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error(JSON.stringify({ error: { code: "conversation_busy", message: "Wait for generation" } }));
      return new ReadableStream({ start(controller) { controller.close(); } });
    },
    reconnectToStream: async () => null,
  } });
  draw().find((node) => node.type === "textarea")?.props.onChange?.({ target: { value: "New question" } });
  await draw().find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  expect(hooks.chat.messages).toEqual([]);
  expect(draw().find((node) => node.type === "textarea")?.props.value).toBe("New question");
  await draw().find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
  expect(requests).toHaveLength(2);
  expect(requests[1].messageId).toBeUndefined();
  expect(hooks.chat.messages).toHaveLength(1);
  expect(hooks.chat.messages[0].parts).toEqual([{ type: "text", text: "New question" }]);
});

it.each(["completed_tool_results", "conversation_busy"])("preserves a current text and image draft when Regenerate receives %s", async (code) => {
  const history: UIMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Create a page" }] },
    { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Done" }] },
  ];
  hooks.chat = new Chat<UIMessage>({ messages: history, onError: (error) => hooks.onError?.(error), transport: {
    sendMessages: async () => { throw new Error(JSON.stringify({ error: { code } })); },
    reconnectToStream: async () => null,
  } });
  const initialBubble = draw().find((node) => node.props.message?.id === "assistant")!;
  draw().find((node) => node.props.message?.id === "user")!.props.onEdit!();
  draw().find((node) => node.type === "textarea")!.props.onChange!({ target: { value: "Keep this draft" } });
  draw().find((node) => node.props.onDrop)!.props.onDrop!({ preventDefault() {}, dataTransfer: { files: [new File(["draft"], "draft.png", { type: "image/png" })] } });
  const nextBubble = draw().find((node) => node.props.message?.id === "assistant")!;
  // React uses shallow prop comparison when memo has no custom comparator.
  const memo = MessageBubble as unknown as { compare: null | ((a: unknown, b: unknown) => boolean) };
  const equal = memo.compare ? memo.compare(initialBubble.props, nextBubble.props)
    : Object.keys(nextBubble.props).every((key) => Object.is(Reflect.get(initialBubble.props, key), Reflect.get(nextBubble.props, key)));
  expect(equal).toBe(false);
  await (equal ? initialBubble : nextBubble).props.onRegenerate!();
  expect(hooks.chat.messages).toEqual(history);
  const tree = draw();
  expect(tree.find((node) => node.type === "textarea")!.props.value).toBe("Keep this draft");
  expect(tree.some((node) => node.props.children === "draft.png")).toBe(true);
  expect(tree.some((node) => node.props.children === "Editing a previous message")).toBe(code === "conversation_busy");
});

it.each([false, true])("freezes image preparation and releases the guard after read failure=%s", async (fails) => {
  let reader: { onload?: () => void; onerror?: () => void } | undefined;
  const read = vi.fn();
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,bmV3";
    onload?: () => void;
    onerror?: () => void;
    readAsDataURL() { read(); reader = { onload: () => this.onload?.(), onerror: () => this.onerror?.() }; }
  });
  const requests: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0][] = [];
  hooks.chat = new Chat<UIMessage>({ messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Original" }] }, { id: "assistant", role: "assistant", parts: [{ type: "text", text: "Response" }] }], transport: {
    sendMessages: async (request) => { requests.push(request); return new ReadableStream({ start(controller) { controller.close(); } }); },
    reconnectToStream: async () => null,
  } });
  draw().find((node) => node.props.message?.id === "user")!.props.onEdit!();
  draw().find((node) => node.type === "textarea")!.props.onChange!({ target: { value: "Send this image" } });
  draw().find((node) => node.props.onDrop)!.props.onDrop!({ preventDefault() {}, dataTransfer: { files: [new File(["new"], "new.png", { type: "image/png" })] } });
  const before = draw();
  const submit = before.find((node) => node.type === "form")!.props.onSubmit!;
  const pending = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  before.find((node) => node.type === "textarea")!.props.onKeyDown!({ key: "Enter", shiftKey: false, preventDefault() {} });
  expect(read).toHaveBeenCalledTimes(1);
  expect(hooks.chat.status).toBe("ready");
  let tree = draw();
  expect(tree.find((node) => node.type === "textarea")!.props.disabled).toBe(true);
  expect(tree.find((node) => node.props.title === "Send message" || node.props.title === "Update message")!.props.disabled).toBe(true);
  expect(tree.some((node) => node.props.title === "Stop generating")).toBe(false);
  expect(tree.find((node) => node.props.title === "Remove attachment")!.props.disabled).toBe(true);
  expect(tree.find((node) => node.props.children === "Cancel")!.props.disabled).toBe(true);
  expect(tree.find((node) => node.props.message?.id === "user")!.props.allowEdit).toBe(false);
  expect(tree.find((node) => node.props.message?.id === "assistant")!.props.allowRegenerate).toBe(false);
  before.find((node) => node.type === "textarea")!.props.onChange!({ target: { value: "Late change" } });
  before.find((node) => node.props.title === "Remove attachment")!.props.onClick!();
  before.find((node) => node.props.children === "Cancel")!.props.onClick!();
  before.find((node) => node.props.onDrop)!.props.onDrop!({ preventDefault() {}, dataTransfer: { files: [new File(["late"], "late.png", { type: "image/png" })] } });
  await before.find((node) => node.props.message?.id === "assistant")!.props.onRegenerate!();
  expect(draw().find((node) => node.type === "textarea")!.props.value).toBe("Send this image");
  if (fails) reader!.onerror!(); else reader!.onload!();
  await pending;
  tree = draw();
  expect(tree.find((node) => node.type === "textarea")!.props.disabled).toBe(false);
  expect(requests).toHaveLength(fails ? 0 : 1);
  if (fails) {
    expect(tree.find((node) => node.type === "textarea")!.props.value).toBe("Send this image");
    expect(tree.some((node) => node.props.children === "new.png")).toBe(true);
    const retry = tree.find((node) => node.type === "form")!.props.onSubmit!({ preventDefault() {} });
    reader!.onload!();
    await retry;
    expect(requests).toHaveLength(1);
  }
  expect(requests[0].messages[0].parts).toEqual([{ type: "text", text: "Send this image" }, { type: "file", mediaType: "image/png", filename: "new.png", url: "data:image/png;base64,bmV3" }]);
});


it.each(["missing credentials", "upstream unavailable"])("restores the previous answer and composer draft after %s blocks regeneration", async (failure) => {
  const history: UIMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Question" }] },
    { id: "old-answer", role: "assistant", parts: [{ type: "text", text: "Keep this useful answer" }] },
  ];
  hooks.chat = new Chat<UIMessage>({
    messages: history,
    onError: (error) => hooks.onError?.(error),
    onFinish: (info) => hooks.onFinish?.(info),
    transport: new DefaultChatTransport({
      fetch: async () => Response.json({ error: { message: failure } }, { status: 400 }),
    }),
  });
  draw().find((node) => node.type === "textarea")!.props.onChange!({ target: { value: "Keep this draft" } });
  draw().find((node) => node.props.onDrop)!.props.onDrop!({ preventDefault() {}, dataTransfer: { files: [new File(["draft"], "draft.png", { type: "image/png" })] } });
  await draw().find((node) => node.props.message?.id === "old-answer")!.props.onRegenerate!();
  expect(hooks.chat.error?.message).toContain(failure);
  expect(hooks.chat.messages).toEqual(history);
  expect(draw().find((node) => node.type === "textarea")!.props.value).toBe("Keep this draft");
  expect(draw().some((node) => node.props.children === "draft.png")).toBe(true);
});

it.each(["completed", "unknown"])("preserves newly streamed %s write evidence after regeneration fails", async (outcome) => {
  const output = { uid: 123, _meta: { operation: "write", outcome } };
  const chunks: UIMessageChunk[] = [
    { type: "start", messageId: "new-answer" },
    { type: "tool-input-available", toolCallId: "write", toolName: "WriteTable", input: {} },
    { type: "tool-output-available", toolCallId: "write", output },
    { type: "error", errorText: "Provider disconnected" },
  ];
  hooks.chat = new Chat<UIMessage>({
    messages: [
      { id: "user", role: "user", parts: [{ type: "text", text: "Question" }] },
      { id: "old-answer", role: "assistant", parts: [{ type: "text", text: "Old answer" }] },
    ],
    onError: (error) => hooks.onError?.(error),
    onFinish: (info) => hooks.onFinish?.(info),
    transport: new DefaultChatTransport({ fetch: async () => createUIMessageStreamResponse({
      stream: new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } }),
    }) }),
  });
  await draw().find((node) => node.props.message?.id === "old-answer")!.props.onRegenerate!();
  expect(hooks.chat.error?.message).toBe("Provider disconnected");
  expect(hooks.chat.messages.at(-1)).toMatchObject({ id: "new-answer", parts: [expect.objectContaining({ state: "output-available", output })] });
});
