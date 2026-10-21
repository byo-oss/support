import { useCallback, useEffect, useRef, useState } from "react";

/** Poll interval of every hook, in ms. */
export const DEFAULT_POLL_INTERVAL = 15_000;

const isHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Resolves a client call's `data`; throws its `error` (or a generic one when
 * both are empty). Hooks catch these and expose them as `error`.
 */
export async function unwrap<T>(
  request: Promise<{ data: T | null; error: unknown }>,
): Promise<T> {
  const res = await request;
  if (res.error) throw res.error;
  if (res.data === null || res.data === undefined) {
    throw new Error("Empty response from the support endpoint");
  }
  return res.data;
}

/** Runs a mutation; a failure goes to `fail` and resolves `{ ok: false }`. */
export async function attempt<T>(
  run: () => Promise<T>,
  fail: (reason: unknown) => void,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (reason) {
    fail(reason);
    return { ok: false };
  }
}

/** Drops keys whose value is undefined, so queries only carry what is set. */
export function compact<T extends Record<string, string | undefined>>(
  query: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

type Snapshot<D> = { scope: string; data: D };

type ResourceInput<D> = {
  /** Identifies what is loaded. A change drops the data and loads again. */
  scope: string;
  /** False: idle (no request, not loading). @default true */
  enabled?: boolean;
  /** 0 disables polling. */
  pollInterval: number;
  load: () => Promise<D>;
  /** Folds a poll's result into what is already held. @default replace */
  merge?: (prev: D, next: D) => D;
};

/**
 * Loads `load()` for a scope, polls it (paused while the tab is hidden,
 * refreshing as soon as it is visible again) and exposes data, loading and
 * error state. Never throws: failures land in `error`. Responses for an
 * older scope or older than one already applied are dropped.
 */
export function useSupportResource<D>(input: ResourceInput<D>) {
  const { scope, enabled = true, pollInterval } = input;
  const [snapshot, setSnapshot] = useState<Snapshot<D> | null>(null);
  const [settledScope, setSettledScope] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const loadRef = useRef(input.load);
  loadRef.current = input.load;
  const mergeRef = useRef(input.merge);
  mergeRef.current = input.merge;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sequenceRef = useRef(0);
  const appliedRef = useRef(0);

  const fail = useCallback((reason: unknown) => {
    setError(() => reason);
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const requestScope = scope;
    const id = ++sequenceRef.current;
    try {
      const next = await loadRef.current();
      if (scopeRef.current !== requestScope || id < appliedRef.current) return;
      appliedRef.current = id;
      setSnapshot((prev) => {
        const merge = mergeRef.current;
        const data =
          merge && prev && prev.scope === requestScope
            ? merge(prev.data, next)
            : next;
        return { scope: requestScope, data };
      });
      setError(null);
    } catch (reason) {
      if (scopeRef.current === requestScope) setError(() => reason);
    } finally {
      // a failed load still ends the initial load, or a client that mounts
      // offline would show a spinner forever
      if (scopeRef.current === requestScope) setSettledScope(requestScope);
    }
  }, [scope, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || pollInterval <= 0) return;
    const interval = setInterval(() => {
      if (isHidden()) return;
      void refresh();
    }, pollInterval);
    const onVisibilityChange = () => {
      if (!isHidden()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, pollInterval, refresh]);

  /** Updates the held data, only while `forScope` is still current. */
  const patch = useCallback((forScope: string, update: (prev: D) => D) => {
    setSnapshot((prev) =>
      prev && prev.scope === forScope
        ? { scope: forScope, data: update(prev.data) }
        : prev,
    );
  }, []);

  return {
    data: snapshot && snapshot.scope === scope ? snapshot.data : null,
    isLoading: enabled && settledScope !== scope,
    error,
    refresh,
    fail,
    patch,
  };
}

type Page<R> = { rows: R[]; nextCursor: string | null };

/**
 * A first page plus the pages `loadMore` appended. A poll replaces the first
 * page and keeps what was loaded beyond it, so a long list doesn't collapse
 * every 15 s.
 */
type PagedData<R, X> = {
  head: R[];
  headCursor: string | null;
  tail: R[];
  tailCursor: string | null;
  loadedMore: boolean;
  extra: X;
};

const pagedRows = <R, X>(data: PagedData<R, X>): R[] => [
  ...data.head,
  ...data.tail,
];

const pagedCursor = <R, X>(data: PagedData<R, X>): string | null =>
  data.loadedMore ? data.tailCursor : data.headCursor;

function mergeFirstPage<R extends { id: string }, X>(
  prev: PagedData<R, X>,
  next: PagedData<R, X>,
): PagedData<R, X> {
  if (!prev.loadedMore) return next;
  const inHead = new Set(next.head.map((row) => row.id));
  return {
    ...next,
    // rows pushed past the first page by newer ones stay, in order
    tail: [...prev.head, ...prev.tail].filter((row) => !inHead.has(row.id)),
    tailCursor: prev.tailCursor,
    loadedMore: true,
  };
}

function appendPage<R extends { id: string }, X>(
  prev: PagedData<R, X>,
  page: Page<R>,
): PagedData<R, X> {
  const seen = new Set(pagedRows(prev).map((row) => row.id));
  return {
    ...prev,
    tail: [...prev.tail, ...page.rows.filter((row) => !seen.has(row.id))],
    tailCursor: page.nextCursor,
    loadedMore: true,
  };
}

type PagedInput<R, X> = {
  scope: string;
  pollInterval: number;
  /** Page one, with whatever else the first request carries (counts, features). */
  fetchFirst: () => Promise<Page<R> & { extra: X }>;
  fetchMore: (cursor: string) => Promise<Page<R>>;
};

/** Cursor-paged list on top of `useSupportResource`. */
export function useSupportPagedResource<R extends { id: string }, X>(
  input: PagedInput<R, X>,
) {
  const fetchFirstRef = useRef(input.fetchFirst);
  fetchFirstRef.current = input.fetchFirst;
  const fetchMoreRef = useRef(input.fetchMore);
  fetchMoreRef.current = input.fetchMore;
  const loadingMoreRef = useRef(false);

  const load = useCallback(async (): Promise<PagedData<R, X>> => {
    const page = await fetchFirstRef.current();
    return {
      head: page.rows,
      headCursor: page.nextCursor,
      tail: [],
      tailCursor: null,
      loadedMore: false,
      extra: page.extra,
    };
  }, []);

  const resource = useSupportResource<PagedData<R, X>>({
    scope: input.scope,
    pollInterval: input.pollInterval,
    load,
    merge: mergeFirstPage,
  });
  const { data, patch, fail } = resource;

  const dataRef = useRef(data);
  dataRef.current = data;
  const scopeRef = useRef(input.scope);
  scopeRef.current = input.scope;

  const loadMore = useCallback(async () => {
    const current = dataRef.current;
    const cursor = current ? pagedCursor(current) : null;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const forScope = scopeRef.current;
    try {
      const page = await fetchMoreRef.current(cursor);
      patch(forScope, (prev) => appendPage(prev, page));
    } catch (reason) {
      if (scopeRef.current === forScope) fail(reason);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [patch, fail]);

  return {
    rows: data ? pagedRows(data) : [],
    extra: data ? data.extra : null,
    hasMore: data ? pagedCursor(data) !== null : false,
    isLoading: resource.isLoading,
    error: resource.error,
    refresh: resource.refresh,
    fail,
    loadMore,
  };
}
