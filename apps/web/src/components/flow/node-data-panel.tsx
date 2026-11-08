"use client";

import { registry } from "@fl0w/blocks";
import type { Json } from "@fl0w/schema";
import { Pin, PinOff, Play, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FLOATING } from "@/lib/floating";
import { parsePin, type BlockNodeData, type BlockNodeType } from "@/lib/flow-convert";
import { cn } from "@/lib/utils";
import { useBlockLabel } from "./use-block-label";
import type { NodeDetail } from "./use-run";

/**
 * Data window of the selected node: what it had in the last run (input, params, output, log, error), pinning the output
 * (pin data) and restarting from this node. Floats on the right under the overall run result window — params and code
 * stay in the window on the left and are edited as before.
 */
export function NodeDataPanel({
  node,
  detail,
  canRunFrom,
  onRunFrom,
  onChange,
  onClose,
}: {
  node: BlockNodeType;
  /** Node data from the last run (if it took part in it). */
  detail?: NodeDetail;
  /** Whether the flow can be restarted from this node (no Watch and no run in progress). */
  canRunFrom: boolean;
  onRunFrom: () => void;
  onChange: (id: string, patch: Partial<BlockNodeData>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("inspector");
  const blockLabel = useBlockLabel();
  if (!registry[node.data.blockType]) return null;

  return (
    <section className={cn(FLOATING, "pointer-events-auto flex min-h-0 shrink flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {blockLabel(node.data.blockType)} <span className="text-muted-foreground font-mono text-xs">{node.id}</span>
        </h2>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!canRunFrom} onClick={onRunFrom} title={t("runFromHint")}>
              <Play className="size-3.5" />
              {t("runFrom")}
            </Button>
            {detail?.output && !node.data.pinData && (
              <Button size="sm" variant="outline" onClick={() => onChange(node.id, { pinData: detail.output })}>
                <Pin className="size-3.5" />
                {t("pin")}
              </Button>
            )}
            {node.data.pinData && (
              <Button size="sm" variant="outline" onClick={() => onChange(node.id, { pinData: null })}>
                <PinOff className="size-3.5" />
                {t("unpin")}
              </Button>
            )}
          </div>
          <PinEditor key={`${node.id}-${node.data.pinData ? "pinned" : "free"}`} pin={node.data.pinData ?? null} onSave={(pinData) => onChange(node.id, { pinData })} />
          {!detail ? (
            <p className="text-muted-foreground text-sm">{t("dataEmpty")}</p>
          ) : (
            <>
              <p className="text-muted-foreground text-xs">{t("dataHint")}</p>
              {detail.error !== undefined && <DataBlock title={t("dataError")} text={detail.error} tone="error" />}
              <DataBlock title={t("dataInput")} text={detail.input === undefined ? undefined : JSON.stringify(detail.input, null, 2)} />
              <DataBlock title={t("dataParams")} text={detail.params === undefined ? undefined : JSON.stringify(detail.params, null, 2)} />
              <DataBlock title={t("dataOutput")} text={detail.output === undefined ? undefined : JSON.stringify(detail.output, null, 2)} />
              {detail.logs.length > 0 && <DataBlock title={t("dataLogs")} text={detail.logs.join("\n")} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Pinned node data (pin data) — JSON `{ port: value }`. Edited by hand: this is how a "webhook request" or a
 * "Telegram message" is set up for debugging without a real event. Applied only in manual runs.
 */
function PinEditor({ pin, onSave }: { pin: Record<string, Json> | null; onSave: (pin: Record<string, Json>) => void }) {
  const t = useTranslations("inspector");
  const [text, setText] = useState(pin ? JSON.stringify(pin, null, 2) : "");
  const [error, setError] = useState<string | null>(null);
  if (!pin && text === "") {
    // collapsed: manual data entry opens with a button
    return (
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setText('{\n  "out0": {}\n}')}>
        {t("pinManual")}
      </Button>
    );
  }
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium">{pin ? t("pinned") : t("pinManualTitle")}</h3>
      <textarea
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className="bg-muted focus-visible:ring-ring h-40 w-full resize-y rounded-md p-2 font-mono text-xs outline-none focus-visible:ring-2"
      />
      {error && <p className="text-destructive text-xs [overflow-wrap:anywhere]">{error}</p>}
      <Button
        size="sm"
        onClick={() => {
          const parsed = parsePin(text);
          if (parsed.ok) onSave(parsed.value);
          else setError(parsed.error);
        }}
      >
        {t("pinSave")}
      </Button>
      <p className="text-muted-foreground text-xs">{t("pinHint")}</p>
    </section>
  );
}

function DataBlock({ title, text, tone }: { title: string; text?: string; tone?: "error" }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium">{title}</h3>
      <pre
        className={cn(
          "bg-muted max-h-64 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]",
          tone === "error" && "text-destructive",
        )}
      >
        {text ?? "—"}
      </pre>
    </section>
  );
}
