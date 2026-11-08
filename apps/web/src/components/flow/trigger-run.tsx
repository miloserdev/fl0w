"use client";

import { createContext, useContext } from "react";

/** Running a single trigger with a button on the node (Manual): only it starts, the other triggers stay silent. */
export type TriggerRunApi = {
  run: (nodeId: string) => void;
  disabled: boolean;
  /** A trial run is in progress (the run button is replaced by pause and stop). */
  running: boolean;
  /** The trigger started by a node button; null — the whole flow was started (controls on all Manual nodes). */
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
