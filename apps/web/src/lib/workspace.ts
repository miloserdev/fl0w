/**
 * Рабочее пространство редактора: несколько флоу во вкладках. Чистая логика состояния вкладок и их хранения в браузере
 * (без React и DOM — тестируется отдельно). Содержимое каждого флоу автосохраняется под своим ключом `fl0w:flow:<id>`.
 */
import { flowSchema, type Flow } from "@fl0w/schema";

export type Tab = { id: string; name: string };
export type TabsState = { tabs: Tab[]; active: string };

export const TABS_KEY = "fl0w:tabs:v2";
/** Ключ единственного флоу старой версии (до вкладок). */
export const LEGACY_FLOW_KEY = "fl0w:flow:v1";
export const flowKey = (id: string) => `fl0w:flow:${id}`;

/** Сколько вкладок можно держать открытыми (каждая — отдельный холст в памяти). */
export const MAX_TABS = 12;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Имя нового флоу: «flow», «flow 2», … — первое, которого нет среди вкладок. */
export function nextName(tabs: Tab[]): string {
  const used = new Set(tabs.map((t) => t.name));
  if (!used.has("flow")) return "flow";
  for (let n = 2; ; n++) if (!used.has(`flow ${n}`)) return `flow ${n}`;
}

/** Добавляет вкладку и делает её активной; уже открытый флоу только активируется. */
export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((t) => t.id === tab.id)) return { ...state, active: tab.id };
  return { tabs: [...state.tabs, tab], active: tab.id };
}

/**
 * Закрывает вкладку. Закрытая активная — активна соседняя (правая, иначе левая). Последняя вкладка заменяется новой пустой
 * (`fresh`): редактор без открытого флоу бессмыслен.
 */
export function closeTab(state: TabsState, id: string, fresh: Tab): TabsState {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return { tabs: [fresh], active: fresh.id };
  const active = state.active === id ? tabs[Math.min(i, tabs.length - 1)]!.id : state.active;
  return { tabs, active };
}

export function renameTab(state: TabsState, id: string, name: string): TabsState {
  const clean = name.trim();
  if (clean === "" || !state.tabs.some((t) => t.id === id && t.name !== clean)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, name: clean } : t)) };
}

export function moveActive(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) && state.active !== id ? { ...state, active: id } : state;
}

function parseFlow(raw: string | null): Flow | null {
  if (!raw) return null;
  try {
    const parsed = flowSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Восстанавливает вкладки из хранилища. Нет сохранённых — переносит флоу старой версии (`fl0w:flow:v1`) в первую вкладку;
 * иначе одна новая пустая. Вкладки, чьё содержимое пропало, остаются (откроются пустыми).
 */
export function loadTabs(store: Store, fresh: () => Tab): TabsState {
  try {
    const raw = store.getItem(TABS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<TabsState>;
      const tabs = Array.isArray(p.tabs)
        ? p.tabs.filter((t): t is Tab => typeof t?.id === "string" && typeof t?.name === "string" && /^[\w-]{1,80}$/.test(t.id)).slice(0, MAX_TABS)
        : [];
      if (tabs.length > 0) return { tabs, active: tabs.some((t) => t.id === p.active) ? (p.active as string) : tabs[0]!.id };
    }
  } catch {
    // битые данные — начинаем заново
  }
  const legacy = parseFlow(store.getItem(LEGACY_FLOW_KEY));
  if (legacy) {
    try {
      store.setItem(flowKey(legacy.id), JSON.stringify(legacy));
      store.removeItem(LEGACY_FLOW_KEY);
    } catch {
      // квота: вкладка всё равно откроется, содержимое подтянется из старого ключа не будет
    }
    return { tabs: [{ id: legacy.id, name: legacy.name }], active: legacy.id };
  }
  const tab = fresh();
  return { tabs: [tab], active: tab.id };
}

export function saveTabs(store: Store, state: TabsState): void {
  try {
    store.setItem(TABS_KEY, JSON.stringify(state));
  } catch {
    // нет хранилища — вкладки не переживут перезагрузку
  }
}

/** Читает автосохранённый флоу вкладки (null — нет или битый). */
export function readFlow(store: Store, id: string): Flow | null {
  try {
    return parseFlow(store.getItem(flowKey(id)));
  } catch {
    return null;
  }
}

export function writeFlow(store: Store, flow: Flow): void {
  try {
    store.setItem(flowKey(flow.id), JSON.stringify(flow));
  } catch {
    // квота или приватный режим
  }
}

export function removeFlow(store: Store, id: string): void {
  try {
    store.removeItem(flowKey(id));
  } catch {
    // не критично
  }
}

/**
 * Флоу остальных вкладок — кандидаты для вызова из пробного запуска (Emitter находит Collector и в несохранённых вкладках).
 * Берём автосохранённые копии; битые и пустые пропускаем.
 */
export function otherFlows(store: Store, tabs: Tab[], exceptId: string): Flow[] {
  const out: Flow[] = [];
  for (const t of tabs) {
    if (t.id === exceptId) continue;
    const f = readFlow(store, t.id);
    if (f && f.nodes.length > 0) out.push(f);
  }
  return out;
}
