"use client";

import { registry } from "@fl0w/blocks";
import { Maximize2, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NodeDetail } from "./use-run";
import type { BlockNodeData, BlockNodeType } from "@/lib/flow-convert";
import { BlockIcon } from "./block-icon";
import { CodeEditor } from "./code-editor";
import { ParamForm } from "./param-form";
import { useBlockLabel } from "./use-block-label";

/**
 * Окно параметров выбранного блока: плавает слева поверх холста и существует,
 * пока выбран ровно один блок. Закрытие снимает выделение.
 */
export function Inspector({
  node,
  detail,
  onChange,
  onClose,
}: {
  node: BlockNodeType;
  /** Данные ноды из последнего запуска (если она в нём участвовала). */
  detail?: NodeDetail;
  onChange: (id: string, patch: Partial<BlockNodeData>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("inspector");
  const blockLabel = useBlockLabel();
  // счётчик «сбросов» CSS: редактор неуправляемый, после сброса к стилям блока его нужно пересоздать
  const [cssEpoch, setCssEpoch] = useState(0);
  const cls = registry[node.data.blockType];
  if (!cls) return null;
  const codeParam = cls.params.find((p) => p.editor === "code");

  return (
    // `nokey` — штатный способ React Flow: внутри этого окна он не обрабатывает клавиши (Backspace/Delete удаляли бы
    // выбранную ноду, Space включал бы панорамирование) — Monaco вводит текст через native-edit-context, который
    // React Flow сам полем ввода не считает
    <aside className={cn(FLOATING, "nokey absolute top-[4.25rem] bottom-3 left-3 z-10 flex w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BlockIcon name={cls.icon} className="text-muted-foreground size-4" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{blockLabel(node.data.blockType)}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{node.id}</div>
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label={t("close")}>
          <X className="size-4" />
        </Button>
      </div>
      {/* key: при смене блока вкладка сбрасывается (у другого блока может не быть вкладки «Код») */}
      <Tabs key={node.id} defaultValue="params" className="min-h-0 flex-1 gap-0">
        <TabsList className="m-3 mb-0 self-start">
          <TabsTrigger value="params">{t("tabParams")}</TabsTrigger>
          {codeParam && <TabsTrigger value="code">{t("tabCode")}</TabsTrigger>}
          <TabsTrigger value="css">{t("tabCss")}</TabsTrigger>
          <TabsTrigger value="data">{t("tabData")}</TabsTrigger>
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
        <TabsContent value="data" className="min-h-0 overflow-y-auto">
          <div className="space-y-3 p-3">
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
        </TabsContent>
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
    </aside>
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

/**
 * Редактор кода во вкладке окна параметров с кнопкой «открыть по центру»: тот же текст в большом окне, как у «Добавить блок».
 * Редакторы неуправляемые (см. CodeEditor): окно монтирует свой редактор с текущим текстом при открытии, а встроенный
 * редактор после закрытия окна пересоздаётся — иначе он показал бы текст на момент открытия.
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
        {/* nokey: React Flow не должен перехватывать клавиши (Backspace/Space) в редакторе, вынесенном в портал */}
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
