/**
 * Editor workspace: several flows in tabs. Pure logic of tab state and of storing them in the browser
 * (no React or DOM — tested separately). The content of each flow is autosaved under its own key `fl0w:flow:<id>`.
 */
import { flowSchema, type Flow } from "@fl0w/schema";

export type Tab = { id: string; name: string };
export type TabsState = { tabs: Tab[]; active: string };

export const TABS_KEY = "fl0w:tabs:v2";
/** Key of the single flow of the old version (before tabs). */
export const LEGACY_FLOW_KEY = "fl0w:flow:v1";
export const flowKey = (id: string) => `fl0w:flow:${id}`;

/** How many tabs can be kept open (each is a separate canvas in memory). */
export const MAX_TABS = 12;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Name of a new flow: "flow", "flow 2", … — the first one not among the tabs. */
export function nextName(tabs: Tab[]): string {
  const used = new Set(tabs.map((t) => t.name));
  if (!used.has("flow")) return "flow";
  for (let n = 2; ; n++) if (!used.has(`flow ${n}`)) return `flow ${n}`;
}

/** Adds a tab and makes it active; an already open flow is only activated. */
export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((t) => t.id === tab.id)) return { ...state, active: tab.id };
  return { tabs: [...state.tabs, tab], active: tab.id };
}

/**
 * Closes a tab. When the active one is closed, the neighbouring one becomes active (the right one, otherwise the left). The last tab is replaced by a new empty one
 * (`fresh`): an editor with no open flow makes no sense.
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
 * Restores tabs from storage. If none are saved, moves the old version's flow (`fl0w:flow:v1`) into the first tab;
 * otherwise one new empty tab. Tabs whose content is gone remain (they open empty).
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
    // broken data — start over
  }
  const legacy = parseFlow(store.getItem(LEGACY_FLOW_KEY));
  if (legacy) {
    try {
      store.setItem(flowKey(legacy.id), JSON.stringify(legacy));
      store.removeItem(LEGACY_FLOW_KEY);
    } catch {
      // quota: the tab will open anyway, the content will not be pulled in from the old key
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
    // no storage — tabs will not survive a reload
  }
}

/** Reads a tab's autosaved flow (null — missing or broken). */
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
    // quota or private mode
  }
}

export function removeFlow(store: Store, id: string): void {
  try {
    store.removeItem(flowKey(id));
  } catch {
    // not critical
  }
}

/**
 * Flows of the other tabs — candidates for calls from a trial run (Emitter finds a Collector in unsaved tabs too).
 * Autosaved copies are taken; broken and empty ones are skipped.
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
