"use client";

import { createContext, useContext } from "react";

/** Запуск одного триггера кнопкой на ноде (Manual): стартует только он, остальные триггеры молчат. */
export type TriggerRunApi = {
  run: (nodeId: string) => void;
  disabled: boolean;
  /** Идёт пробный запуск (кнопка запуска заменяется паузой и остановкой). */
  running: boolean;
  /** Триггер, запущенный кнопкой на ноде; null — запущен весь флоу (управление на всех Manual). */
  startedBy: string | null;
  paused: boolean;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

const noop = () => {};
const TriggerRunContext = createContext<TriggerRunApi>({ run: noop, disabled: true, running: false, startedBy: null, paused: false, pause: noop, resume: noop, stop: noop });

export const TriggerRunProvider = TriggerRunContext.Provider;

export function useTriggerRun(): TriggerRunApi {
  return useContext(TriggerRunContext);
}
