"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  ControlButton,
  Controls,
  SelectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { registry } from "@fl0w/blocks";
import { validateFlow } from "@fl0w/engine";
import type { Flow } from "@fl0w/schema";
import { Grid3x3, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { IssueEntry } from "@/components/issues-menu";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import {
  defaultParams,
  edgeClassFor,
  fromReactFlow,
  getPorts,
  nodePortKind,
  newNodeId,
  nodeTypeFor,
  toReactFlow,
  type BlockNodeData,
  collectSeeds,
  flowFingerprint,
  sameStructure,
  type BlockNodeType,
  type FlowMeta,
} from "@/lib/flow-convert";
import { readFlow, writeFlow } from "@/lib/workspace";
import { parseClipboard, pasteNodes, serializeSelection } from "@/lib/clipboard";
import { History } from "@/lib/history";
import { canConnect } from "@/lib/connection";
import { isLayoutBlock, isResizableBlock, layoutNodeProps, layoutPalette, layoutSize, nodeBox, nodesInsideGroup } from "@/lib/layout";
import { FLOATING } from "@/lib/floating";
import { issueNodeIds, useIssueText } from "@/lib/issue-text";
import { cn } from "@/lib/utils";
import { AddBlockDialog } from "./add-block-dialog";
import { BlockNode } from "./block-node";
import { GroupNode, NoteNode } from "./layout-nodes";
import { CurrentFlowProvider } from "./flow-picker";
import { TriggerRunProvider, type TriggerRunApi } from "./trigger-run";
import { NodeLogsProvider } from "./node-logs";
import { TerminalNode } from "./terminal-node";
import { Inspector } from "./inspector";
import { NodeIssuesProvider } from "./node-issues";
import { NodeDataPanel } from "./node-data-panel";
import { RunPanel } from "./run-panel";
import { RunStatusProvider } from "./run-status";
import { usePublish } from "./use-publish";
import { useRun } from "./use-run";
import { useWatch } from "./use-watch";

const nodeTypes = { block: BlockNode, "layout-note": NoteNode, "layout-group": GroupNode, terminal: TerminalNode };

const noopSubscribe = () => () => {};

/** Snap-to-grid step (matches the background step). */
const GRID = 20;
/** localStorage key of the "snap to grid" setting. */
const SNAP_KEY = "fl0w:snap-to-grid";
const AUTOSAVE_DELAY_MS = 400;
/** Pause after the last edit, after which it becomes a history step (typing in a field is one step, not one per letter). */
const HISTORY_DELAY_MS = 350;
/** Approximate node size: so a new block lands centred, not with its corner at the screen centre. */
const NODE_HALF = { x: 90, y: 40 };

/** Node colour on the minimap: notes and groups get their own colour, the rest the standard one. */
function miniMapColor(n: { data: unknown }): string {
  const d = n.data as BlockNodeData;
  return isLayoutBlock(d.blockType) ? layoutPalette(d.params.color).mini : "";
}

export type EditorInfo = { id: string; hasServerCopy: boolean; published: boolean; nodeCount: number; running: boolean };

type EditorProps = {
  /** Identifier of this tab's flow: the content is autosaved under it. */
  flowId: string;
  name: string;
  /** The tab is visible: hotkeys and the clipboard work only in the active one. */
  active: boolean;
  onRename: (name: string) => void;
  onInfo: (info: EditorInfo) => void;
  /** Open a flow from a file: the workspace decides in which tab. */
  onOpenFile: (flow: Flow) => void;
  /** Flows of the other tabs: a trial run finds a Collector for Emitter in them. */
  getOthers: () => Flow[];
};

function Editor({ flowId, name, active, onRename, onInfo, onOpenFile, getOthers }: EditorProps) {
  const t = useTranslations();
  const { resolvedTheme } = useTheme();
  // The theme is unknown on the server: render light until hydration, otherwise React Flow's class diverges from the client.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const issueText = useIssueText();
  const { screenToFlowPosition, getEdges, getNodes, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const meta = useMemo<FlowMeta>(() => ({ id: flowId, name }), [flowId, name]);
  // snap to grid while dragging; the setting is remembered in the browser (read after hydration)
  const [snap, setSnap] = useState(false);
  useEffect(() => {
    // in a timer — not a setState inside an effect
    const timer = setTimeout(() => {
      try {
        if (localStorage.getItem(SNAP_KEY) === "1") setSnap(true);
      } catch {
        // localStorage is unavailable — work without remembering
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const toggleSnap = () => {
    setSnap((v) => {
      try {
        localStorage.setItem(SNAP_KEY, v ? "0" : "1");
      } catch {
        // not critical
      }
      return !v;
    });
  };
  const [error, setError] = useState<{ title: string; items: string[] } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const { state: runState, run, stop, pause, resume, reset: resetRun } = useRun();
  const [watchOn, setWatchOn] = useState(false);
  const { server, busy: publishBusy, save: saveToServer } = usePublish(meta.id);

  /** Camera after programmatically replacing nodes: the nodes must have time to be measured. */
  const fitSoon = useCallback(() => {
    setTimeout(() => void fitView({ maxZoom: 1, padding: 0.3 }), 60);
  }, [fitView]);

  // Restoring the autosaved flow. Not in the state initializer: there is no localStorage on the server,
  // and a different first render would cause a hydration mismatch. Deferred into a timer — not a setState inside an effect.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        // a structurally valid flow is restored even with wrong params — live validation will highlight them
        const saved = readFlow(localStorage, flowId);
        if (saved && saved.nodes.every((n) => registry[n.type])) {
          const rf = toReactFlow(saved);
          setNodes(rf.nodes);
          setEdges(rf.edges);
          if (saved.name !== name) onRename(saved.name);
          if (rf.nodes.length > 0) fitSoon();
        }
      } catch {
        // no access to storage or broken data — start from an empty canvas
      }
      setRestored(true);
    }, 0);
    return () => clearTimeout(timer);
    // restore once when the tab mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges, fitSoon, flowId]);

  // Autosave with a delay; do not write before restoring, otherwise the saved one is overwritten with an empty canvas.
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      // quota or private mode — autosave just does not work (writeFlow swallows the error)
      writeFlow(localStorage, fromReactFlow(nodes, edges, meta));
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [restored, nodes, edges, meta]);

  // --- history (Ctrl+Z / Ctrl+Shift+Z), clipboard (Ctrl+C / X / V), other keys ---
  const history = useRef(new History());
  const latest = useRef({ nodes, edges });
  useEffect(() => {
    latest.current = { nodes, edges };
  });
  // after restoring the flow, history starts from it: otherwise Ctrl+Z would "undo" the loading itself
  useEffect(() => {
    if (restored) history.current.reset({ nodes: latest.current.nodes, edges: latest.current.edges });
  }, [restored]);
  // the edit has "settled" (mouse released, typing finished) — one step goes into history
  useEffect(() => {
    if (!restored || nodes.some((n) => n.dragging)) return;
    const timer = setTimeout(() => history.current.commit({ nodes, edges }), HISTORY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [restored, nodes, edges]);
  const applyDoc = useCallback(
    (doc: { nodes: BlockNodeType[]; edges: Edge[] } | null) => {
      if (!doc) return;
      setNodes(doc.nodes);
      setEdges(doc.edges);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (!active) return;
    /** An input field, code editor, etc.: there the keys and clipboard belong to the field itself. */
    const editable = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".monaco-editor, [role=dialog], [role=menu]") !== null);
    const removeSelected = () => {
      const { nodes: ns } = latest.current;
      const ids = new Set(ns.filter((n) => n.selected).map((n) => n.id));
      if (ids.size === 0) return;
      setNodes((cur) => cur.filter((n) => !ids.has(n.id)));
      setEdges((cur) => cur.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    };
    const doPaste = (text: string) => {
      const clip = parseClipboard(text);
      if (!clip) return false;
      const pasted = pasteNodes(clip, latest.current.nodes);
      setNodes((cur) => [...cur.map((n) => (n.selected ? { ...n, selected: false } : n)), ...pasted.nodes]);
      setEdges((cur) => [...cur.map((e) => (e.selected ? { ...e, selected: false } : e)), ...pasted.edges]);
      return true;
    };
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (editable(e.target) || (window.getSelection()?.toString() ?? "") !== "") return;
      const text = serializeSelection(latest.current.nodes, latest.current.edges);
      if (text === null || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      if (cut) removeSelected();
    };
    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    const paste = (e: ClipboardEvent) => {
      if (editable(e.target)) return;
      if (doPaste(e.clipboardData?.getData("text/plain") ?? "")) e.preventDefault();
    };
    const keydown = (e: KeyboardEvent) => {
      if (editable(e.target) || e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      // by physical key (code): works in a Russian layout too
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        applyDoc(e.shiftKey ? history.current.redo() : history.current.undo());
      } else if (mod && e.code === "KeyY") {
        e.preventDefault();
        applyDoc(history.current.redo());
      } else if (mod && e.code === "KeyA") {
        e.preventDefault();
        setNodes((cur) => cur.map((n) => (n.selected ? n : { ...n, selected: true })));
      } else if (mod && e.code === "KeyD") {
        // duplicate the selection: copy and paste without the system clipboard
        e.preventDefault();
        const text = serializeSelection(latest.current.nodes, latest.current.edges);
        if (text) doPaste(text);
      } else if (!mod && !e.altKey && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        setAddOpen(true);
      }
    };
    document.addEventListener("copy", copy);
    document.addEventListener("cut", cut);
    document.addEventListener("paste", paste);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("copy", copy);
      document.removeEventListener("cut", cut);
      document.removeEventListener("paste", paste);
      document.removeEventListener("keydown", keydown);
    };
  }, [active, applyDoc, setNodes, setEdges]);

  /** A new block lands in the centre of the visible area and is selected at once — its window opens on the left. */
  const addBlock = (blockType: string) => {
    if (!registry[blockType]) return;
    const r = wrapper.current?.getBoundingClientRect();
    const jitter = (nodes.length % 6) * 24;
    const center = r
      ? screenToFlowPosition({ x: r.left + r.width / 2 + jitter, y: r.top + r.height / 2 + jitter })
      : { x: jitter, y: jitter };
    const params = defaultParams(blockType);
    // decoration blocks are centred by their own size, ordinary ones by the approximate one
    const half = isResizableBlock(blockType)
      ? { x: layoutSize(blockType, params).width / 2, y: layoutSize(blockType, params).height / 2 }
      : NODE_HALF;
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      {
        id: newNodeId(blockType),
        type: nodeTypeFor(blockType),
        position: { x: center.x - half.x, y: center.y - half.y },
        selected: true,
        ...layoutNodeProps(blockType, params),
        data: {
          blockType,
          params,
          portsOverride: null,
          cssOverride: null,
        },
      },
    ]);
    setAddOpen(false);
  };

  const updateNodeData = useCallback(
    (id: string, patch: Partial<BlockNodeData>) => {
      // ports may depend on parameters (the err port of outgoing call exists only in await mode): edges to vanished ports are removed
      if (patch.params) {
        const cur = (getNodes() as BlockNodeType[]).find((n) => n.id === id);
        if (cur) {
          const ports = getPorts(cur.data.blockType, cur.data.portsOverride, patch.params);
          setEdges((es) =>
            es.filter(
              (e) =>
                !(e.source === id && !ports.outputs.some((p) => p.id === e.sourceHandle)) &&
                !(e.target === id && !ports.inputs.some((p) => p.id === e.targetHandle)),
            ),
          );
        }
      }
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n;
          const next = { ...n, data: { ...n.data, ...patch } };
          // size of a decoration block from the parameters window → into the node itself (stored in params, drawn by node.width/height)
          return patch.params && isResizableBlock(n.data.blockType)
            ? { ...next, ...layoutSize(n.data.blockType, patch.params) }
            : next;
        }),
      );
    },
    [setNodes, setEdges, getNodes],
  );

  // Live validation: the same rules as in the engine and API. Problem nodes are highlighted on the canvas.
  const liveNodes = useDeferredValue(nodes);
  const liveEdges = useDeferredValue(edges);
  // dragging changes only the position — then the structure (and the expensive validation of the whole flow) stays the same
  const [structure, setStructure] = useState({ nodes: liveNodes, edges: liveEdges });
  if ((structure.nodes !== liveNodes || structure.edges !== liveEdges) && !sameStructure(structure, { nodes: liveNodes, edges: liveEdges })) {
    setStructure({ nodes: liveNodes, edges: liveEdges });
  }
  const deferredNodes = structure.nodes;
  const deferredEdges = structure.edges;
  const deferredFlow = useMemo(
    () => fromReactFlow(deferredNodes, deferredEdges, meta),
    [deferredNodes, deferredEdges, meta],
  );
  const { issues, nodeIssues } = useMemo(() => {
    const checked = validateFlow(deferredFlow, registry);
    const entries: IssueEntry[] = [];
    const byNode: Record<string, string[]> = {};
    if (!checked.ok) {
      checked.issues.forEach((i, idx) => {
        const text = issueText(i);
        const ids = issueNodeIds(i);
        entries.push({ key: `${i.code}-${idx}`, text, nodeId: ids[0] });
        for (const id of ids) (byNode[id] ??= []).push(text);
      });
    }
    return { issues: entries, nodeIssues: byNode };
    // issueText depends on the locale — when it changes the texts are rebuilt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFlow, t]);

  // Publishing and Watch. The server copy is what runs: local edits do not change it until "Update".
  const published = server?.status === "published";
  const dirty = published && server.fingerprint !== flowFingerprint(deferredFlow);
  const hasTrigger = deferredNodes.some((n) => !n.data.disabled && registry[n.data.blockType]?.autoTrigger);
  const watching = watchOn && published;
  const watch = useWatch(meta.id, watching, server?.nodeIds ?? []);
  const view = watching ? watch.state : runState;
  // log lines and captions per node — for the terminal (Log) and the number instead of the icon (Counter) on the canvas
  // the tab reports to the workspace what the tab strip and closing need
  const hasServerCopy = server !== null;
  const running = runState.status === "running";
  useEffect(() => {
    onInfo({ id: flowId, hasServerCopy, published, nodeCount: nodes.length, running });
  }, [onInfo, flowId, hasServerCopy, published, nodes.length, running]);
  const nodeLogs = useMemo(() => Object.fromEntries(Object.entries(view.nodeDetails).map(([id, d]) => [id, { logs: d.logs, display: d.display }])), [view.nodeDetails]);

  const onPublish = async () => {
    const checked = validateFlow(fromReactFlow(nodes, edges, meta), registry);
    if (!checked.ok) {
      setError({ title: t("errors.invalidFlow"), items: checked.issues.map(issueText) });
      return;
    }
    const failure = await saveToServer(checked.flow, "published");
    setError(failure === null ? null : { title: t("errors.publishFailed"), items: [failure] });
  };

  const onUnpublish = async () => {
    if (!server) return;
    // send the server copy: local edits may be invalid, but unpublishing must always work
    const failure = await saveToServer(server.flow, "draft");
    if (failure === null) {
      setWatchOn(false);
      setError(null);
    } else {
      setError({ title: t("errors.publishFailed"), items: [failure] });
    }
  };

  const selectNode = (id: string | null) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    if (id) void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 });
  };

  // Moving a group: blocks whose centres lay inside the frame at the start are shifted by the same delta.
  // Whatever React Flow drags itself (the selection together with the group) is left alone, otherwise the shift would double.
  const groupDrag = useRef<{ id: string; origin: { x: number; y: number }; children: Map<string, { x: number; y: number }> } | null>(null);
  const onNodeDragStart = useCallback(
    (_: unknown, node: BlockNodeType, dragged: BlockNodeType[]) => {
      groupDrag.current = null;
      if (node.data.blockType !== "group") return;
      const all = getNodes() as BlockNodeType[];
      const ids = new Set(nodesInsideGroup(nodeBox(node), all.map(nodeBox)));
      const children = new Map<string, { x: number; y: number }>();
      // dragged — whatever React Flow drags itself (the group and the selection with it)
      const own = new Set(dragged.map((d) => d.id));
      for (const n of all) if (ids.has(n.id) && !own.has(n.id)) children.set(n.id, { ...n.position });
      groupDrag.current = { id: node.id, origin: { ...node.position }, children };
    },
    [getNodes],
  );
  const onNodeDrag = useCallback(
    (_: unknown, node: BlockNodeType) => {
      const g = groupDrag.current;
      if (!g || g.id !== node.id || g.children.size === 0) return;
      const dx = node.position.x - g.origin.x;
      const dy = node.position.y - g.origin.y;
      setNodes((ns) =>
        ns.map((n) => {
          const start = g.children.get(n.id);
          return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n;
        }),
      );
    },
    [setNodes],
  );
  const onNodeDragStop = useCallback(() => {
    groupDrag.current = null;
  }, []);

  // the node data window is closed with the cross for this node (when another is selected it shows again)
  const [dataClosedFor, setDataClosedFor] = useState<string | null>(null);
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;

  const isValidConnection = useCallback(
    (c: Connection | Edge) => canConnect(getNodes() as BlockNodeType[], getEdges(), c),
    [getEdges, getNodes],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const src = (getNodes() as BlockNodeType[]).find((n) => n.id === c.source);
      const kind = src ? nodePortKind(src.data.blockType, src.data.portsOverride, "outputs", c.sourceHandle, src.data.params) : null;
      setEdges((es) =>
        addEdge({ ...c, id: `e_${Math.random().toString(36).slice(2, 8)}`, className: edgeClassFor(kind) }, es),
      );
    },
    [setEdges, getNodes],
  );

  // which trigger was started with the node button (null — the whole flow was started): pause and stop are shown only on it
  const [startedBy, setStartedBy] = useState<string | null>(null);
  const onRun = (from?: string, trigger?: string) => {
    const checked = validateFlow(fromReactFlow(nodes, edges, meta), registry);
    if (!checked.ok) {
      setError({ title: t("errors.invalidFlow"), items: checked.issues.map(issueText) });
      return;
    }
    setError(null);
    setStartedBy(trigger ?? null);
    // restart from a node: predecessors take outputs from the last run
    void run(checked.flow, { others: getOthers(), ...(from ? { from: { nodeId: from, seeds: collectSeeds(runState.nodeDetails) } } : {}), ...(trigger ? { trigger } : {}) });
  };

  // the run button on a Manual node: unavailable while a run is in progress or watching is on
  // the context value is stable until the run changes: otherwise all nodes would re-render on every mouse move
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  });
  const triggerRunApi = useMemo<TriggerRunApi>(
    () => ({
      run: (nodeId) => onRunRef.current(undefined, nodeId),
      disabled: runState.status === "running" || watching,
      running: runState.status === "running" && !watching,
      startedBy,
      paused: runState.paused === true,
      pause,
      resume,
      stop,
    }),
    [runState.status, runState.paused, watching, startedBy, pause, resume, stop],
  );

  const onSave = () => {
    const flow = fromReactFlow(nodes, edges, meta);
    const url = URL.createObjectURL(new Blob([JSON.stringify(flow, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.name || "flow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onLoad = async (file: File) => {
    try {
      const checked = validateFlow(JSON.parse(await file.text()), registry);
      if (!checked.ok) {
        setError({ title: t("errors.invalidFile"), items: checked.issues.map(issueText) });
        return;
      }
      setError(null);
      onOpenFile(checked.flow);
    } catch {
      setError({ title: t("errors.notJson"), items: [] });
    }
  };

  return (
    <div ref={wrapper} className="relative h-full w-full overflow-hidden">
      <NodeIssuesProvider value={nodeIssues}>
        <TriggerRunProvider value={triggerRunApi}>
        <CurrentFlowProvider value={meta.id}>
        <NodeLogsProvider value={nodeLogs}>
        <RunStatusProvider value={view.nodes}>
          <ReactFlow
            // unique id per tab: React Flow's SVG background-pattern and edge-marker ids depend on it — a shared one gave an empty background on neighbouring canvases
            id={flowId}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            // a selected group must not float above the blocks (its zIndex is below zero)
            elevateNodesOnSelect={false}
            isValidConnection={isValidConnection}
            colorMode={hydrated && resolvedTheme === "dark" ? "dark" : "light"}
            // selection by a frame with the left button on empty space (partially covered nodes too), the group is moved as a whole;
            // panning — with the middle/right button (Space is given to Monaco, see panActivationKeyCode), Ctrl/Cmd — add to the selection
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            onPaneContextMenu={(e) => e.preventDefault()}
            snapToGrid={snap}
            snapGrid={[GRID, GRID]}
            deleteKeyCode={["Backspace", "Delete"]}
            // Space is "panning" by default: React Flow swallows it in Monaco too (its input goes through
            // native-edit-context, which React Flow does not consider an input field). We pan by dragging.
            panActivationKeyCode={null}
            minZoom={0.2}
            maxZoom={2}
            fitView
            // on large flows draw only what is in the frame
            onlyRenderVisibleElements
          >
            <Background id={flowId} gap={GRID} />
            <Controls position="bottom-center" orientation="horizontal" showInteractive={false}>
              <ControlButton
                onClick={toggleSnap}
                aria-pressed={snap}
                aria-label={t("canvas.snapToGrid")}
                title={t("canvas.snapToGrid")}
                className={snap ? "bg-accent" : undefined}
              >
                <Grid3x3 />
              </ControlButton>
            </Controls>
            <MiniMap pannable zoomable position="bottom-right" nodeColor={miniMapColor} />
          </ReactFlow>
        </RunStatusProvider>
        </NodeLogsProvider>
        </CurrentFlowProvider>
        </TriggerRunProvider>
      </NodeIssuesProvider>

      {nodes.length === 0 && (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm">
          {t("canvas.empty")}
        </div>
      )}

      <Topbar
        runStatus={view.status}
        manualRunning={runState.status === "running"}
        canRun={nodes.length > 0 && issues.length === 0 && !watching}
        publish={{
          published,
          dirty,
          busy: publishBusy,
          blockedBy: issues.length > 0 ? "issues" : hasTrigger ? null : "noTrigger",
          onPublish: () => void onPublish(),
          onUnpublish: () => void onUnpublish(),
        }}
        watch={{
          on: watching,
          available: published,
          connected: watch.connected,
          onToggle: () => setWatchOn((v) => !v),
        }}
        issues={issues}
        onSelectIssueNode={selectNode}
        onAdd={() => setAddOpen(true)}
        onRun={() => onRun()}
        onStop={stop}
        onSave={onSave}
        onLoad={onLoad}
      />

      {error && (
        <div className={cn(FLOATING, "text-destructive border-destructive/40 absolute top-[4.25rem] left-1/2 z-20 flex max-h-40 w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 items-start gap-2 overflow-y-auto px-3 py-2 text-sm")}>
          <div className="flex-1">
            <p className="font-medium">{error.title}</p>
            {error.items.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {error.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
          </div>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => setError(null)} aria-label={t("errors.dismiss")}>
            <X className="size-4" />
          </Button>
        </div>
      )}

      {selectedNode && (
        <Inspector node={selectedNode} onChange={updateNodeData} onClose={() => selectNode(null)} />
      )}
      {/* right column: the overall run result, below it — the selected node's data (a separate window) */}
      <div className="pointer-events-none absolute top-[4.25rem] right-3 z-10 flex max-h-[calc(100dvh-18.75rem)] w-96 max-w-[calc(100%-1.5rem)] flex-col gap-3">
  <RunPanel
        state={view}
        live={watching ? { connected: watch.connected } : undefined}
        onClose={watching ? () => setWatchOn(false) : () => resetRun(true)}
      />
        {selectedNode && !registry[selectedNode.data.blockType]?.layout && dataClosedFor !== selectedNode.id && (
          <NodeDataPanel
            node={selectedNode}
            detail={view.nodeDetails[selectedNode.id]}
            canRunFrom={!watching && runState.status !== "running"}
            onRunFrom={() => onRun(selectedNode.id)}
            onChange={updateNodeData}
            onClose={() => setDataClosedFor(selectedNode.id)}
          />
        )}
      </div>


      <AddBlockDialog open={addOpen} onOpenChange={setAddOpen} onPick={addBlock} />
    </div>
  );
}

export function FlowEditor(props: EditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
