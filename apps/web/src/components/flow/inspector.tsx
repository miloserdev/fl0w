"use client";

import { registry } from "@fl0w/blocks";
import { RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FLOATING } from "@/lib/floating";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  onChange,
  onClose,
}: {
  node: BlockNodeType;
  onChange: (id: string, patch: Partial<BlockNodeData>) => void;
  onClose: () => void;
}) {
  const t = useTranslations("inspector");
  const blockLabel = useBlockLabel();
  const cls = registry[node.data.blockType];
  if (!cls) return null;
  const codeParam = cls.params.find((p) => p.editor === "code");

  return (
    <aside className={cn(FLOATING, "absolute top-[4.25rem] bottom-3 left-3 z-10 flex w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden")}>
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
        </TabsList>
        <TabsContent value="params" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3">
              <ParamForm
                blockType={node.data.blockType}
                schema={cls.params}
                values={node.data.params}
                onChange={(params) => onChange(node.id, { params })}
              />
            </div>
          </ScrollArea>
        </TabsContent>
        {codeParam && (
          <TabsContent value="code" className="flex min-h-0 flex-col">
            <p className="text-muted-foreground px-3 py-2 text-xs">{t("codeHint")}</p>
            <div className="min-h-0 flex-1 border-t">
              <CodeEditor
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
              onClick={() => onChange(node.id, { cssOverride: null })}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 border-t">
            <CodeEditor
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
