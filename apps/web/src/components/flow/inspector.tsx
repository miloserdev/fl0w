"use client";

import { registry } from "@fl0w/blocks";
import { Maximize2, Power, PowerOff, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BlockNodeData, BlockNodeType } from "@/lib/flow-convert";
import { BlockIcon } from "./block-icon";
import { CodeEditor } from "./code-editor";
import { ParamForm } from "./param-form";
import { useBlockLabel } from "./use-block-label";

/**
 * Parameters window of the selected block: floats on the left over the canvas and exists
 * while exactly one block is selected. Closing it clears the selection.
 */
export function Inspector({
  node,
  onChange,
  onClose,
}: {
  node: BlockNodeType;
  onChange: (id: string, patch: Partial<BlockNodeData>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("inspector");
  const blockLabel = useBlockLabel();
  // counter of CSS "resets": the editor is uncontrolled, after a reset to the block's styles it must be recreated
  const [cssEpoch, setCssEpoch] = useState(0);
  const cls = registry[node.data.blockType];
  if (!cls) return null;
  const codeParam = cls.params.find((p) => p.editor === "code");
  // notes and groups: only parameters — no runs, no code, no block styles
  const layout = cls.layout;

  return (
    // `nokey` is React Flow's standard way: inside this window it does not handle keys (Backspace/Delete would delete
    // the selected node, Space would turn on panning) — Monaco takes input via native-edit-context, which
    // React Flow does not consider an input field itself
    <aside className={cn(FLOATING, "nokey absolute top-[4.25rem] bottom-3 left-3 z-10 flex w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BlockIcon name={cls.icon} className="text-muted-foreground size-4" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{blockLabel(node.data.blockType)}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{node.id}</div>
        </div>
        {!layout && (
          <Button
            variant={node.data.disabled ? "secondary" : "ghost"}
            size="icon"
            className="size-7"
            aria-pressed={node.data.disabled === true}
            title={node.data.disabled ? t("enableNode") : t("disableNode")}
            aria-label={node.data.disabled ? t("enableNode") : t("disableNode")}
            onClick={() => onChange(node.id, { disabled: !node.data.disabled })}
          >
            {node.data.disabled ? <Power className="size-4" /> : <PowerOff className="size-4" />}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" />
        </Button>
      </div>
      {/* key: when the block changes the tab is reset (another block may have no "Code" tab) */}
      {layout ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ParamForm
            blockType={node.data.blockType}
            schema={cls.params}
            values={node.data.params}
            onChange={(params) => onChange(node.id, { params })}
          />
        </div>
      ) : (
      <Tabs key={node.id} defaultValue="params" className="min-h-0 flex-1 gap-0">
        <TabsList className="m-3 mb-0 self-start">
          <TabsTrigger value="params">{t("tabParams")}</TabsTrigger>
          {codeParam && <TabsTrigger value="code">{t("tabCode")}</TabsTrigger>}
          <TabsTrigger value="css">{t("tabCss")}</TabsTrigger>
        </TabsList>
        <TabsContent value="params" className="min-h-0 overflow-y-auto">
          <div>
            <div className="p-3">
              <ParamForm
                blockType={node.data.blockType}
                schema={cls.params}
                values={node.data.params}
                onChange={(params) => onChange(node.id, { params })}
              />
            </div>
          </div>
        </TabsContent>
        {codeParam && (
          <TabsContent value="code" className="flex min-h-0 flex-col">
            <p className="text-muted-foreground px-3 py-2 text-xs">{t("codeHint")}</p>
            <div className="min-h-0 flex-1 border-t">
              <ExpandableEditor
                title={`${blockLabel(node.data.blockType)} — ${t("tabCode")}`}
                language="javascript"
                envTypes={cls.codeTypes}
                value={
                  typeof node.data.params[codeParam.name] === "string"
                    ? (node.data.params[codeParam.name] as string)
                    : String(codeParam.default ?? "")
                }
                onChange={(code) =>
                  onChange(node.id, { params: { ...node.data.params, [codeParam.name]: code } })
                }
              />
            </div>
          </TabsContent>
        )}
        <TabsContent value="css" className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <p className="text-muted-foreground text-xs">{t("cssHint")}</p>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              disabled={node.data.cssOverride === null}
              aria-label={t("cssReset")}
              title={t("cssReset")}
              onClick={() => {
                onChange(node.id, { cssOverride: null });
                setCssEpoch((n) => n + 1);
              }}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 border-t">
            <ExpandableEditor
              key={`css-${cssEpoch}`}
              title={`${blockLabel(node.data.blockType)} — ${t("tabCss")}`}
              language="css"
              value={node.data.cssOverride ?? cls.defaultCss}
              onChange={(css) => onChange(node.id, { cssOverride: css })}
            />
          </div>
        </TabsContent>
      </Tabs>
      )}
    </aside>
  );
}


/**
 * Code editor in a tab of the parameters window with an "open in the centre" button: the same text in a large window, like "Add block".
 * Editors are uncontrolled (see CodeEditor): the window mounts its own editor with the current text on open, and the embedded
 * editor is recreated after the window closes — otherwise it would show the text as of the opening.
 */
function ExpandableEditor({
  title,
  language,
  value,
  onChange,
  envTypes,
}: {
  title: string;
  language: "css" | "javascript";
  value: string;
  onChange: (code: string) => void;
  envTypes?: string;
}) {
  const t = useTranslations("inspector");
  const [open, setOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);

  return (
    <div className="relative h-full">
      <CodeEditor key={epoch} language={language} envTypes={envTypes} value={value} onChange={onChange} />
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-3 z-10 size-7 opacity-70 hover:opacity-100"
        title={t("expand")}
        aria-label={t("expand")}
        onClick={() => setOpen(true)}
      >
        <Maximize2 className="size-4" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setEpoch((n) => n + 1);
        }}
      >
        {/* nokey: React Flow must not intercept keys (Backspace/Space) in an editor moved to a portal */}
        <DialogContent className={cn(FLOATING, "nokey flex h-[85dvh] flex-col gap-3 p-4 sm:max-w-[min(92vw,72rem)]")}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{t("expandDescription")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <CodeEditor language={language} envTypes={envTypes} value={value} onChange={onChange} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

