/** Идущие запуски песочницы: управление паузой по runId, который клиент присылает вместе с POST /api/run. */
export type RunControl = { pause: () => void; resume: () => void };

const g = globalThis as { __fl0wRunControls?: Map<string, RunControl> };
export const runControls = (g.__fl0wRunControls ??= new Map<string, RunControl>());

export const isRunId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{8,64}$/.test(v);
