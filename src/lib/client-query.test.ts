import { describe, expect, it, vi } from "vitest";
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
});
