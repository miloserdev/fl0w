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
import { flowSchema } from "@fl0w/schema";
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
  newFlowId,
  newNodeId,
  nodeTypeFor,
  toReactFlow,
  type BlockNodeData,
  collectSeeds,
  flowFingerprint,
  type BlockNodeType,
  type FlowMeta,
} from "@/lib/flow-convert";
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

/** Шаг сетки привязки (совпадает с шагом фона). */
const GRID = 20;
/** Ключ настройки «привязка к сетке» в localStorage. */
const SNAP_KEY = "fl0w:snap-to-grid";
/** Ключ автосохранения в localStorage (формат — тот же JSON-флоу, что и в файле). */
const STORAGE_KEY = "fl0w:flow:v1";
const AUTOSAVE_DELAY_MS = 400;
/** Примерный размер ноды: чтобы новый блок встал центром, а не углом в центр экрана. */
const NODE_HALF = { x: 90, y: 40 };

/** Цвет ноды на миникарте: заметки и группы — своим цветом, остальные — стандартным. */
function miniMapColor(n: { data: unknown }): string {
  const d = n.data as BlockNodeData;
  return isLayoutBlock(d.blockType) ? layoutPalette(d.params.color).mini : "";
}

function Editor() {
  const t = useTranslations();
  const { resolvedTheme } = useTheme();
  // На сервере тема неизвестна: до гидрации рендерим light, иначе class у React Flow расходится с клиентом.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const issueText = useIssueText();
  const { screenToFlowPosition, getEdges, getNodes, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [meta, setMeta] = useState<FlowMeta>(() => ({ id: newFlowId(), name: "flow" }));
  // привязка к сетке при перетаскивании; настройка запоминается в браузере (читается после гидратации)
  const [snap, setSnap] = useState(false);
  useEffect(() => {
    // в таймере — не setState внутри эффекта
    const timer = setTimeout(() => {
      try {
        if (localStorage.getItem(SNAP_KEY) === "1") setSnap(true);
      } catch {
        // localStorage недоступен — работаем без запоминания
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const toggleSnap = () => {
    setSnap((v) => {
      try {
        localStorage.setItem(SNAP_KEY, v ? "0" : "1");
      } catch {
        // не критично
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

  /** Камера после программной замены нод: узлы должны успеть измериться. */
  const fitSoon = useCallback(() => {
    setTimeout(() => void fitView({ maxZoom: 1, padding: 0.3 }), 60);
  }, [fitView]);

  // Восстановление автосохранённого флоу. Не в инициализаторе state: на сервере localStorage нет,
  // и разный первый рендер дал бы hydration mismatch. Отложено в таймер — не setState внутри эффекта.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = flowSchema.safeParse(JSON.parse(raw));
          // структурно валидный флоу восстанавливаем и с неверными params — их подсветит живая валидация
          if (parsed.success && parsed.data.nodes.every((n) => registry[n.type])) {
            const rf = toReactFlow(parsed.data);
            setNodes(rf.nodes);
            setEdges(rf.edges);
            setMeta({ id: parsed.data.id, name: parsed.data.name });
            if (rf.nodes.length > 0) fitSoon();
          }
        }
      } catch {
        // нет доступа к хранилищу или битые данные — стартуем с пустого холста
      }
      setRestored(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [setNodes, setEdges, fitSoon]);

  // Автосохранение с задержкой; до восстановления не пишем, иначе затрём сохранённое пустым холстом.
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fromReactFlow(nodes, edges, meta)));
      } catch {
        // квота или приватный режим — автосохранение просто не работает
      }
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [restored, nodes, edges, meta]);

  /** Новый блок встаёт в центр видимой области и сразу выбирается — слева открывается его окно. */
  const addBlock = (blockType: string) => {
    if (!registry[blockType]) return;
    const r = wrapper.current?.getBoundingClientRect();
    const jitter = (nodes.length % 6) * 24;
    const center = r
      ? screenToFlowPosition({ x: r.left + r.width / 2 + jitter, y: r.top + r.height / 2 + jitter })
      : { x: jitter, y: jitter };
    const params = defaultParams(blockType);
    // блоки оформления центрируются по своему размеру, обычные — по примерному
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
      // порты могут зависеть от параметров (порт err у outgoing call только в режиме await): рёбра к исчезнувшим портам снимаются
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
          // размер блока оформления из окна параметров → в саму ноду (хранится в params, рисуется по node.width/height)
          return patch.params && isResizableBlock(n.data.blockType)
            ? { ...next, ...layoutSize(n.data.blockType, patch.params) }
            : next;
        }),
      );
    },
    [setNodes, setEdges, getNodes],
  );

  // Живая валидация: те же правила, что в движке и API. Проблемные ноды подсвечиваются на холсте.
  const deferredNodes = useDeferredValue(nodes);
  const deferredEdges = useDeferredValue(edges);
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
    // issueText зависит от локали — при её смене тексты пересобираются
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFlow, t]);

  // Публикация и Watch. Исполняется серверная копия: локальные правки до «Обновить» её не меняют.
  const published = server?.status === "published";
  const dirty = published && server.fingerprint !== flowFingerprint(deferredFlow);
  const hasTrigger = deferredNodes.some((n) => !n.data.disabled && registry[n.data.blockType]?.autoTrigger);
  const watching = watchOn && published;
  const watch = useWatch(meta.id, watching, server?.nodeIds ?? []);
  const view = watching ? watch.state : runState;
  // строки лога и подписи по нодам — для терминала (Log) и числа вместо иконки (Counter) на холсте
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
    // отправляем серверную копию: локальные правки могут быть невалидны, а снять публикацию нужно всегда
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

  // Перенос группы: блоки, чьи центры лежали в рамке на момент начала, сдвигаются на ту же дельту.
  // То, что React Flow тащит сам (выделенное вместе с группой), — их не трогаем, иначе сдвиг удвоится.
  const groupDrag = useRef<{ id: string; origin: { x: number; y: number }; children: Map<string, { x: number; y: number }> } | null>(null);
  const onNodeDragStart = useCallback(
    (_: unknown, node: BlockNodeType, dragged: BlockNodeType[]) => {
      groupDrag.current = null;
      if (node.data.blockType !== "group") return;
      const all = getNodes() as BlockNodeType[];
      const ids = new Set(nodesInsideGroup(nodeBox(node), all.map(nodeBox)));
      const children = new Map<string, { x: number; y: number }>();
      // dragged — то, что React Flow тащит сам (группа и выделенное вместе с ней)
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

  // окно данных ноды закрыто крестиком для этой ноды (при выборе другой снова показывается)
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

  // какой триггер запустили кнопкой на ноде (null — запуск всего флоу): пауза и стоп показываются только на нём
  const [startedBy, setStartedBy] = useState<string | null>(null);
  const onRun = (from?: string, trigger?: string) => {
    const checked = validateFlow(fromReactFlow(nodes, edges, meta), registry);
    if (!checked.ok) {
      setError({ title: t("errors.invalidFlow"), items: checked.issues.map(issueText) });
      return;
    }
    setError(null);
    setStartedBy(trigger ?? null);
    // перезапуск с ноды: предшественники берут выходы из последнего запуска
    void run(checked.flow, { ...(from ? { from: { nodeId: from, seeds: collectSeeds(runState.nodeDetails) } } : {}), ...(trigger ? { trigger } : {}) });
  };

  // кнопка запуска на ноде Manual: недоступна, пока идёт запуск или включено наблюдение
  const triggerRunApi: TriggerRunApi = {
    run: (nodeId) => onRun(undefined, nodeId),
    disabled: runState.status === "running" || watching,
    running: runState.status === "running" && !watching,
    startedBy,
    paused: runState.paused === true,
    pause,
    resume,
    stop,
  };

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
      const rf = toReactFlow(checked.flow);
      setNodes(rf.nodes);
      setEdges(rf.edges);
      setMeta({ id: checked.flow.id, name: checked.flow.name });
      setError(null);
      resetRun();
      fitSoon();
    } catch {
      setError({ title: t("errors.notJson"), items: [] });
    }
  };

  return (
    <div ref={wrapper} className="relative h-dvh w-full overflow-hidden">
      <NodeIssuesProvider value={nodeIssues}>
        <TriggerRunProvider value={triggerRunApi}>
        <CurrentFlowProvider value={meta.id}>
        <NodeLogsProvider value={nodeLogs}>
        <RunStatusProvider value={view.nodes}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            // выделенная группа не должна всплывать над блоками (у неё zIndex ниже нуля)
            elevateNodesOnSelect={false}
            isValidConnection={isValidConnection}
            colorMode={hydrated && resolvedTheme === "dark" ? "dark" : "light"}
            // выделение рамкой левой кнопкой по пустому месту (частично попавшие ноды тоже), группа переносится целиком;
            // панорамирование — средней/правой кнопкой (Space отдан Monaco, см. panActivationKeyCode), Ctrl/Cmd — добавить к выделению
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            onPaneContextMenu={(e) => e.preventDefault()}
            snapToGrid={snap}
            snapGrid={[GRID, GRID]}
            deleteKeyCode={["Backspace", "Delete"]}
            // Space по умолчанию — «панорамирование»: React Flow глушит его и в Monaco (его ввод идёт через
            // native-edit-context, который React Flow не считает полем ввода). Панорамируем перетаскиванием.
            panActivationKeyCode={null}
            minZoom={0.2}
            maxZoom={2}
            fitView
          >
            <Background gap={GRID} />
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
      {/* правая колонка: общий результат запуска, под ним — данные выбранной ноды (отдельное окно) */}
      <div className="pointer-events-none absolute top-[4.25rem] right-3 z-10 flex max-h-[calc(100dvh-16.5rem)] w-96 max-w-[calc(100%-1.5rem)] flex-col gap-3">
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

export function FlowEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
