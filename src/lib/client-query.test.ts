import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/deferred";
import {
  createClientQueryStore,
  createDebouncedKeyDispatcher,
} from "@/lib/client-query";

describe("client query policy", () => {
  it("debounces query key updates into one notification per window", () => {
    vi.useFakeTimers();
    const onKey = vi.fn();
    const dispatcher = createDebouncedKeyDispatcher(250, onKey);

    dispatcher.update(["conversations", "a"]);
    vi.advanceTimersByTime(100);
    dispatcher.update(["conversations", "ab"]);
    vi.advanceTimersByTime(100);
    dispatcher.update(["conversations", "abc"]);

    expect(onKey).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(onKey).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith(["conversations", "abc"]);

    dispatcher.cancel();
    vi.useRealTimers();
  });

  it("shares one in-flight request between consumers of the same key", async () => {
    const store = createClientQueryStore();
    let resolveRequest: (value: string[]) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = store.fetchQuery("conversations:", fetcher);
    const second = store.fetchQuery("conversations:", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);

    resolveRequest(["one"]);

    await expect(first).resolves.toEqual(["one"]);
    await expect(second).resolves.toEqual(["one"]);
    expect(store.getSnapshot<string[]>("conversations:").data).toEqual(["one"]);
  });

  it.each(["rename", "delete"])("keeps a committed %s when an older read completes", async (operation) => {
    const store = createClientQueryStore();
    const before = [{ id: "one", title: "Old" }];
    const after = operation === "rename" ? [{ id: "one", title: "Saved" }] : [];
    await store.fetchQuery("conversations", async () => before);
    const response = deferred<typeof before>();
    const reading = store.fetchQuery("conversations", () => response.promise);

    store.mutate(() => true, () => after);
    response.resolve(before);
    await reading;

    expect(store.getSnapshot("conversations")).toMatchObject({
      data: after, error: null, isLoading: false, isRefreshing: false,
    });
  });

  it("ignores an older read error after a successful mutation", async () => {
    const store = createClientQueryStore();
    await store.fetchQuery("settings", async () => "A");
    const response = deferred<string>();
    const reading = store.fetchQuery("settings", () => response.promise);
    store.mutate(() => true, () => "B");
    response.reject(new Error("Old request failed"));
    await expect(reading).rejects.toThrow("Old request failed");
    expect(store.getSnapshot("settings")).toMatchObject({ data: "B", error: null });
  });

  it.each(["success", "error"])("coalesces invalidations and awaits a fresh read after stale %s", async (outcome) => {
    const store = createClientQueryStore();
    await store.fetchQuery("settings", async () => "A");
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const fetcher = vi.fn(() => fresh.promise).mockImplementationOnce(() => stale.promise);
    const reading = store.fetchQuery("settings", fetcher);
    const first = Promise.all(store.revalidate());
    const second = Promise.all(store.revalidate());
    const finished = vi.fn();
    void second.then(finished);

    if (outcome === "success") stale.resolve("stale");
    else stale.reject(new Error("Stale error"));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(finished).not.toHaveBeenCalled();
    expect(store.getSnapshot("settings")).toMatchObject({ data: "A", error: null, isRefreshing: true });

    store.mutate(() => true, () => "B");
    fresh.resolve("older than B");
    await Promise.all([reading, first, second]);
    expect(store.getSnapshot("settings")).toMatchObject({ data: "B", error: null, isRefreshing: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revalidates at the microtask boundary where the preceding read settles", async () => {
    const store = createClientQueryStore();
    const response = deferred<string>();
    const fetcher = vi.fn(async () => "fresh").mockImplementationOnce(() => response.promise);
    const reading = store.fetchQuery("settings", fetcher);
    const invalidation = response.promise.then(() => Promise.all(store.revalidate()));
    response.resolve("old");
    await Promise.all([reading, invalidation]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot("settings")).toMatchObject({ data: "fresh", isRefreshing: false });
  });
});
