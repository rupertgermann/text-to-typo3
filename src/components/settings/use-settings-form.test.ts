import { Children, isValidElement, type DependencyList, type EffectCallback, type ReactNode, type SetStateAction } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicUserSettings } from "@/lib/user-settings";

// The project has no DOM renderer; drive hook state and effects while using the real query store.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { deps: DependencyList | undefined; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  cursor: 0,
  dirty: false,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) {
      hooks.states[index] = typeof initial === "function"
        ? (initial as () => T)() : initial;
    }
    return [hooks.states[index], (next: SetStateAction<T>) => {
      const value = typeof next === "function"
        ? (next as (previous: T) => T)(hooks.states[index] as T) : next;
      if (!Object.is(value, hooks.states[index])) hooks.dirty = true;
      hooks.states[index] = value;
    }];
  },
  useMemo: <T>(factory: () => T) => factory(),
  useCallback: <T>(callback: T) => callback,
  useEffect(effect: EffectCallback, deps?: DependencyList) {
    const index = hooks.cursor++;
    const previous = hooks.effects[index];
    if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]))) {
      hooks.pending.push(() => {
        previous?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: effect() || undefined };
      });
    }
  },
}));

const saved: PublicUserSettings = {
  userId: "user-1",
  modelId: "custom:provider:model", modelContextWindow: 10000,
  hasOpenAIKey: true, lmstudioBaseUrl: "http://saved.local/v1",
  lmstudioModelId: "saved-local",
  customProviders: [{ id: "provider", displayName: "Saved provider",
    baseUrl: "http://saved-provider.local/v1", hasApiKey: true }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let useSettingsForm: typeof import("./use-settings-form").useSettingsForm;
let SettingsModal: typeof import("./settings-modal").SettingsModal;
let request: ReturnType<typeof deferred<Response>>;
let opened: boolean;
const onSaved = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
function render<T>(component: () => T) {
  let result: T;
  let renders = 0;
  do {
    hooks.dirty = false;
    hooks.cursor = 0;
    result = component();
    for (const effect of hooks.pending.splice(0)) effect();
    if (++renders > 30) throw new Error("Hook render did not settle");
  } while (hooks.dirty);
  return result;
}
function draw() {
  return render(function SettingsHarness() {
    return useSettingsForm({ open: opened, onSaved });
  });
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return draw();
}
function patches() {
  return fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH");
}
beforeEach(async () => {
  vi.resetModules();
  hooks.states = []; hooks.effects = []; hooks.pending = [];
  opened = true;
  onSaved.mockReset();
  request = deferred<Response>();
  vi.stubGlobal("window", new EventTarget());
  fetchMock.mockReset().mockImplementation(async (url, options) => {
    if (options?.method === "PATCH") return Response.json(saved);
    if (url === "/api/settings") return request.promise;
    return new Response("");
  });
  vi.stubGlobal("fetch", fetchMock);
  ({ useSettingsForm } = await import("./use-settings-form"));
  ({ SettingsModal } = await import("./settings-modal"));
});
afterEach(() => {
  for (const effect of hooks.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

it("does not PATCH while the first settings GET is pending", async () => {
  await draw().handleSave();
  expect(patches()).toHaveLength(0);
  expect(onSaved).not.toHaveBeenCalled();
});
it("does not PATCH after the first settings GET fails", async () => {
  draw();
  request.reject(new Error("Settings unavailable"));
  const form = await settle();
  expect(form.error).toBe("Settings unavailable");
  await form.handleSave();
  expect(patches()).toHaveLength(0);
});
it("saves loaded settings, the selected model, and entered provider keys", async () => {
  draw(); request.resolve(Response.json(saved));
  let form = await settle();
  form.setSelectedModelId("custom:provider:other");
  form.setOpenaiKey("new-openai-key");
  form.updateCustomProvider("provider", { apiKey: "new-provider-key" });
  form = draw();
  await form.handleSave();
  expect(patches()).toHaveLength(1);
  expect(JSON.parse(String(patches()[0][1]?.body))).toEqual({
    modelId: "custom:provider:other", openaiApiKey: "new-openai-key",
    lmstudioBaseUrl: saved.lmstudioBaseUrl, lmstudioModelId: saved.lmstudioModelId,
    customProviders: [{ id: "provider", displayName: "Saved provider",
      baseUrl: "http://saved-provider.local/v1", apiKey: "new-provider-key" }],
  });
  expect(onSaved).toHaveBeenCalledOnce();
});
it("keeps the cached reopen draft through a delayed GET and initializes the next session", async () => {
  draw(); request.resolve(Response.json(saved)); await settle();
  opened = false; draw();
  request = deferred<Response>();
  opened = true;
  let form = draw();
  expect(form.lmstudioBaseUrl).toBe(saved.lmstudioBaseUrl);
  form.setLmstudioBaseUrl("http://edited.local/v1");
  form.setSelectedModelId("custom:provider:edited");
  form.setOpenaiKey("draft-openai-key");
  form.updateCustomProvider("provider", { apiKey: "draft-key" });
  form.addCustomProvider();
  form = draw();
  const added = form.customProviders[1];
  form.updateCustomProvider(added.id, { displayName: "New provider", baseUrl: "http://new.local/v1", apiKey: "new-key" });
  const refreshed = { ...saved, lmstudioBaseUrl: "http://refreshed.local/v1" };
  request.resolve(Response.json(refreshed));
  form = await settle();
  expect(form.lmstudioBaseUrl).toBe("http://edited.local/v1");
  expect(form.selectedModelId).toBe("custom:provider:edited");
  expect(form.openaiKey).toBe("draft-openai-key");
  expect(form.customProviders).toHaveLength(2);
  expect(form.customProviders[0].apiKey).toBe("draft-key");
  expect(form.customProviders[1]).toMatchObject({ displayName: "New provider", apiKey: "new-key" });
  opened = false; form = draw();
  expect(form.openaiKey).toBe("");
  expect(form.customProviders).toEqual([]);
  await form.handleSave();
  expect(patches()).toHaveLength(0);
  request = deferred<Response>();
  opened = true; form = draw();
  expect(form.lmstudioBaseUrl).toBe(refreshed.lmstudioBaseUrl);
  expect(form.selectedModelId).toBe(saved.modelId);
  expect(form.customProviders).toHaveLength(1);
  expect(form.customProviders[0].apiKey).toBe("");
  expect(form.openaiKey).toBe("");
});

function findSaveButton(node: ReactNode): { disabled?: boolean } | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean }>(child)) continue;
    if (Children.toArray(child.props.children).includes("Save settings")) return child.props;
    const found = findSaveButton(child.props.children);
    if (found) return found;
  }
}
it("disables the modal Save button until its settings draft is initialized", async () => {
  const modal = () => render(() => SettingsModal({ displayName: "User", typo3BaseUrl: "https://typo3.test" }));
  let tree = modal();
  tree.props.onOpenChange(true);
  tree = modal();
  expect(findSaveButton(tree)?.disabled).toBe(true);
  request.resolve(Response.json(saved));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  tree = modal();
  expect(findSaveButton(tree)?.disabled).toBe(false);
});
