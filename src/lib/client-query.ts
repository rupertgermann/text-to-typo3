"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export const SETTINGS_UPDATED_EVENT = "text-to-typo3-settings-updated";

export type ClientQueryKey = readonly unknown[];

type QueryKeyMatcher = (serializedKey: string) => boolean;

type QuerySnapshot<T> = {
  data: T | undefined;
  error: Error | null;
  hasData: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
};

type QueryEntry<T> = QuerySnapshot<T> & {
  fetcher: (() => Promise<T>) | null;
  inFlight: Promise<T> | null;
  listeners: Set<() => void>;
};

type UseClientQueryOptions<T> = {
  key: ClientQueryKey;
  fetcher: () => Promise<T>;
  enabled?: boolean;
  keepPreviousData?: boolean;
  revalidateOn?: string[];
};

const emptySnapshot: QuerySnapshot<never> = {
  data: undefined,
  error: null,
  hasData: false,
  isLoading: false,
  isRefreshing: false,
};

export function serializeClientQueryKey(key: ClientQueryKey): string {
  return JSON.stringify(key);
}

export function createDebouncedKeyDispatcher<T>(
  delayMs: number,
  onKey: (key: T) => void,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    update(key: T) {
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        onKey(key);
      }, delayMs);
    },
    cancel() {
      if (!timer) {
        return;
      }

      clearTimeout(timer);
      timer = null;
    },
  };
}

export function createClientQueryStore() {
  const entries = new Map<string, QueryEntry<unknown>>();

  function getOrCreateEntry<T>(serializedKey: string): QueryEntry<T> {
    let entry = entries.get(serializedKey) as QueryEntry<T> | undefined;

    if (!entry) {
      entry = {
        ...emptySnapshot,
        fetcher: null,
        inFlight: null,
        listeners: new Set(),
      };
      entries.set(serializedKey, entry as QueryEntry<unknown>);
    }

    return entry;
  }

  function notify(entry: QueryEntry<unknown>) {
    entry.listeners.forEach((listener) => listener());
  }

  function getSnapshot<T>(serializedKey: string): QuerySnapshot<T> {
    const entry = entries.get(serializedKey) as QueryEntry<T> | undefined;
    if (!entry) {
      return emptySnapshot;
    }

    return {
      data: entry.data,
      error: entry.error,
      hasData: entry.hasData,
      isLoading: entry.isLoading,
      isRefreshing: entry.isRefreshing,
    };
  }

  function subscribe(serializedKey: string, listener: () => void) {
    const entry = getOrCreateEntry(serializedKey);
    entry.listeners.add(listener);

    return () => {
      entry.listeners.delete(listener);
    };
  }

  function fetchQuery<T>(
    serializedKey: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const entry = getOrCreateEntry<T>(serializedKey);
    entry.fetcher = fetcher;

    if (entry.inFlight) {
      return entry.inFlight as Promise<T>;
    }

    entry.isLoading = !entry.hasData;
    entry.isRefreshing = entry.hasData;
    entry.error = null;
    notify(entry as QueryEntry<unknown>);

    const request = fetcher()
      .then((data) => {
        entry.data = data;
        entry.hasData = true;
        entry.error = null;
        return data;
      })
      .catch((error: unknown) => {
        entry.error = error instanceof Error ? error : new Error(String(error));
        throw error;
      })
      .finally(() => {
        entry.inFlight = null;
        entry.isLoading = false;
        entry.isRefreshing = false;
        notify(entry as QueryEntry<unknown>);
      });

    entry.inFlight = request;
    return request;
  }

  function revalidate(
    matcher: QueryKeyMatcher = () => true,
  ): Array<Promise<unknown>> {
    const requests: Array<Promise<unknown>> = [];

    entries.forEach((entry, serializedKey) => {
      if (!entry.fetcher || !matcher(serializedKey)) {
        return;
      }

      requests.push(fetchQuery(serializedKey, entry.fetcher).catch(() => null));
    });

    return requests;
  }

  function mutate<T>(
    matcher: QueryKeyMatcher,
    updater: (current: T | undefined) => T | undefined,
  ) {
    entries.forEach((entry, serializedKey) => {
      if (!entry.hasData || !matcher(serializedKey)) {
        return;
      }

      const nextData = updater(entry.data as T | undefined);
      if (nextData === undefined) {
        return;
      }

      entry.data = nextData;
      entry.hasData = true;
      notify(entry);
    });
  }

  function clear() {
    entries.clear();
  }

  return {
    clear,
    fetchQuery,
    getSnapshot,
    mutate,
    revalidate,
    subscribe,
  };
}

const clientQueryStore = createClientQueryStore();

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const dispatcher = createDebouncedKeyDispatcher(delayMs, setDebouncedValue);
    dispatcher.update(value);

    return () => dispatcher.cancel();
  }, [delayMs, value]);

  return debouncedValue;
}

export function useClientQuery<T>({
  key,
  fetcher,
  enabled = true,
  keepPreviousData = false,
  revalidateOn = [],
}: UseClientQueryOptions<T>) {
  const serializedKey = useMemo(() => serializeClientQueryKey(key), [key]);
  const [viewState, setViewState] = useState<{
    previousData: T | undefined;
    version: number;
  }>(() => {
    const snapshot = clientQueryStore.getSnapshot<T>(serializedKey);

    return {
      previousData: snapshot.hasData ? snapshot.data : undefined,
      version: 0,
    };
  });

  useEffect(() => {
    return clientQueryStore.subscribe(serializedKey, () => {
      const snapshot = clientQueryStore.getSnapshot<T>(serializedKey);
      setViewState((current) => ({
        previousData: snapshot.hasData ? snapshot.data : current.previousData,
        version: current.version + 1,
      }));
    });
  }, [serializedKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void clientQueryStore.fetchQuery(serializedKey, fetcher).catch(() => null);
  }, [enabled, fetcher, serializedKey]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || revalidateOn.length === 0) {
      return;
    }

    const revalidateCurrentQuery = () => {
      void clientQueryStore.revalidate((keyString) => keyString === serializedKey);
    };

    revalidateOn.forEach((eventName) => {
      window.addEventListener(eventName, revalidateCurrentQuery);
    });

    return () => {
      revalidateOn.forEach((eventName) => {
        window.removeEventListener(eventName, revalidateCurrentQuery);
      });
    };
  }, [enabled, revalidateOn, serializedKey]);

  const snapshot = clientQueryStore.getSnapshot<T>(serializedKey);
  const data =
    keepPreviousData && !snapshot.hasData && viewState.previousData !== undefined
      ? viewState.previousData
      : snapshot.data;

  const mutate = useCallback(
    (updater: (current: T | undefined) => T | undefined) => {
      clientQueryStore.mutate<T>(
        (keyString) => keyString === serializedKey,
        updater,
      );
    },
    [serializedKey],
  );

  return {
    data,
    error: snapshot.error,
    isLoading: enabled && snapshot.isLoading && data === undefined,
    isRefreshing:
      snapshot.isRefreshing || (enabled && !snapshot.hasData && data !== undefined),
    mutate,
  };
}

export function revalidateClientQueries(matcher?: QueryKeyMatcher) {
  return clientQueryStore.revalidate(matcher);
}

export function mutateClientQueries<T>(
  matcher: QueryKeyMatcher,
  updater: (current: T | undefined) => T | undefined,
) {
  clientQueryStore.mutate<T>(matcher, updater);
}
