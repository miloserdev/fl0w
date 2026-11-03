"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * Контекст «id → значение», в котором потребитель перерисовывается только при изменении СВОЕГО значения.
 * Обычный Context с картой заставил бы каждую из сотен нод перерисоваться при любом изменении карты
 * (например, при статусе одной ноды во время запуска) — на больших флоу это и есть лаги.
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

  /** Значение по id, пропущенное через `select`; `select` должен возвращать то же значение (===), пока данные те же. */
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
