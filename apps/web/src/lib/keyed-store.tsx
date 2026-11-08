"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * An "id → value" context where a consumer re-renders only when ITS OWN value changes.
 * An ordinary Context with a map would make each of hundreds of nodes re-render on any change of the map
 * (for example, on one node's status during a run) — on large flows that is exactly the lag.
 */
export function createKeyedStore<T>() {
  type Store = { get: (id: string) => T | undefined; subscribe: (cb: () => void) => () => void };
  const empty: Store = { get: () => undefined, subscribe: () => () => {} };
  const Ctx = createContext<Store>(empty);

  function Provider({ value, children }: { value: Record<string, T>; children: ReactNode }) {
    const current = useRef(value);
    const listeners = useRef(new Set<() => void>());
    const store = useMemo<Store>(
      () => ({
        get: (id) => current.current[id],
        subscribe: (cb) => {
          listeners.current.add(cb);
          return () => void listeners.current.delete(cb);
        },
      }),
      [],
    );
    useLayoutEffect(() => {
      if (current.current === value) return;
      current.current = value;
      for (const l of [...listeners.current]) l();
    }, [value]);
    return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
  }

  /** Value by id, passed through `select`; `select` must return the same value (===) while the data is the same. */
  function useSelected<R>(id: string, select: (v: T | undefined) => R): R {
    const store = useContext(Ctx);
    return useSyncExternalStore(
      store.subscribe,
      () => select(store.get(id)),
      () => select(undefined),
    );
  }

  return { Provider, useSelected };
}
