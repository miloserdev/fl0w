"use client";

import { createContext, useContext } from "react";

/** Запуск одного триггера кнопкой на ноде (Manual): стартует только он, остальные триггеры молчат. */
export type TriggerRunApi = { run: (nodeId: string) => void; disabled: boolean };

const TriggerRunContext = createContext<TriggerRunApi>({ run: () => {}, disabled: true });

export const TriggerRunProvider = TriggerRunContext.Provider;

export function useTriggerRun(): TriggerRunApi {
  return useContext(TriggerRunContext);
}
