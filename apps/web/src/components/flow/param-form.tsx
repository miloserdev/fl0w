"use client";

import { isParamVisible, registry, resolveParams } from "@fl0w/blocks";
import type { Json, ParamSchema } from "@fl0w/schema";
import { useTranslations } from "next-intl";
import { Braces } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { layoutPalette } from "@/lib/layout";
import { Tip } from "@/components/tip";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { ExpressionField } from "./expression-field";
import { ChannelPicker } from "./flow-picker";
import { hasTemplate, insertTemplate } from "./expression-segments";

type Props = {
  blockType: string;
  schema: ParamSchema[];
  values: Record<string, Json>;
  onChange: (next: Record<string, Json>) => void;
};

function isEmpty(v: Json | undefined) {
  return v === undefined || v === null || v === "";
}

function JsonField({
  id,
  value,
  onValid,
  register,
  plain,
}: {
  id: string;
  value: Json | undefined;
  onValid: (v: Json) => void;
  /** отдаёт форме функцию вставки шаблона в позицию курсора (кнопка `{ }` в шапке поля) */
  register: (insert: () => void) => void;
  plain?: boolean;
}) {
  const t = useTranslations("inspector");
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [invalid, setInvalid] = useState(false);

  const change = (next: string) => {
    setText(next);
    try {
      // строки с `{{ … }}` внутри JSON — обычные строки, разбор их не затрагивает
      onValid(JSON.parse(next) as Json);
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  };
  register(() => {
    const el = document.getElementById(id) as HTMLTextAreaElement | null;
    const r = insertTemplate(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, { json: true });
    change(r.text);
    focusCaret(id, r.caret);
  });

  return (
    <>
      <ExpressionField id={id} plain={plain} value={text} multiline invalid={invalid} className="min-h-28" onChange={change} />
      {invalid && <p className="text-destructive text-xs">{t("invalidJson")}</p>}
    </>
  );
}

function focusCaret(id: string, caret: number) {
  setTimeout(() => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(caret, caret);
  }, 0);
}

/** Авто-UI настроек блока из `class.params`. */
/** Типы, у которых виджет не принимает текст: для выражения нужен переключатель в текстовый режим. */
const TOGGLEABLE = ["number", "boolean", "enum", "multienum"];

export function ParamForm({ blockType, schema, values, onChange }: Props) {
  const t = useTranslations();
  // режим «выражение» держится, пока поле редактируют: иначе виджет сменился бы обратно, как только в тексте
  // не осталось `{{ }}` (например, при стирании)
  const [exprMode, setExprMode] = useState<Record<string, boolean>>({});
  // вставка шаблона для JSON-полей (у них текст хранится внутри JsonField)
  const jsonInsert = useRef<Record<string, () => void>>({});

  // параметры с editor: "code" правятся во вкладке кода, а не в форме
  // блоки оформления (заметки, группы) не вычисляют выражений
  const plainOnly = registry[blockType]?.layout === true;
  const resolved = resolveParams(schema, values);
  const fields = schema.filter((p) => p.editor !== "code" && isParamVisible(p, resolved));

  if (fields.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("inspector.noParams")}</p>;
  }

  const set = (name: string, value: Json | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-4">
      {fields.map((p) => {
        const id = `param-${blockType}-${p.name}`;
        const key = `params.${blockType}.${p.name}`;
        const label = t.has(key) ? t(key) : (p.label ?? p.name);
        const value = values[p.name] ?? p.default;
        const missing = p.required && isEmpty(value);
        const toggleable = TOGGLEABLE.includes(p.type) && p.expressions !== false && !plainOnly;
        const expr = toggleable && (exprMode[p.name] ?? hasTemplate(value));
        const highlighted =
          p.expressions !== false && (expr || hasTemplate(value) || (p.type === "json" && hasTemplate(JSON.stringify(value))));
        const outOfRange =
          p.type === "number" &&
          typeof value === "number" &&
          ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max));
        const range =
          p.type === "number"
            ? [p.min !== undefined && `≥ ${p.min}`, p.max !== undefined && `≤ ${p.max}`].filter(Boolean).join(", ")
            : "";
        const optionLabel = (o: { value: string; label?: string }) => {
          const k = `paramOptions.${p.name}.${o.value}`;
          return t.has(k) ? t(k) : (o.label ?? o.value);
        };

        return (
          <div key={p.name} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={id}>
                {label}
                {p.required && <span className="text-destructive">*</span>}
                {highlighted && (
                  <span className="bg-primary/15 text-primary ml-1.5 rounded px-1 font-mono text-[10px] font-normal">
                    {"{ }"} {t("inspector.expressionBadge")}
                  </span>
                )}
              </Label>
              {(p.type === "string" || p.type === "json") && p.expressions !== false && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  title={t("inspector.insertExpression")}
                  aria-label={t("inspector.insertExpression")}
                  // вставка шаблона из входа в позицию курсора: можно смешивать с обычным текстом
                  onClick={() => {
                    if (p.type === "json") return jsonInsert.current[p.name]?.();
                    const text = typeof value === "string" ? value : "";
                    const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
                    const r = insertTemplate(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length);
                    set(p.name, r.text);
                    focusCaret(id, r.caret);
                  }}
                >
                  <Braces className="size-3.5" />
                </Button>
              )}
              {toggleable && (
                <Button
                  type="button"
                  variant={expr ? "secondary" : "ghost"}
                  size="icon"
                  className="size-6"
                  aria-pressed={expr}
                  title={expr ? t("inspector.fixedToggle") : t("inspector.expressionToggle")}
                  aria-label={expr ? t("inspector.fixedToggle") : t("inspector.expressionToggle")}
                  onClick={() => {
                    setExprMode((m) => ({ ...m, [p.name]: !expr }));
                    // в выражение — заготовка; обратно — значение по умолчанию (а не текст выражения в числовое поле)
                    set(p.name, expr ? p.default : "{{ inputs.in0. }}");
                  }}
                >
                  <Braces className="size-3.5" />
                </Button>
              )}
            </div>

            {expr && (
              <ExpressionField
                id={id}
                forceExpression
                value={typeof value === "string" ? value : ""}
                placeholder="{{ inputs.in0.field }}"
                onChange={(v) => set(p.name, v)}
              />
            )}

            {p.type === "string" && p.picker && (
              <ChannelPicker
                id={id}
                kind={p.picker}
                value={typeof value === "string" ? value : ""}
                invalid={missing}
                onChange={(v) => set(p.name, v)}
              />
            )}

            {p.type === "string" && !p.picker && (
              <ExpressionField
                id={id}
                multiline={p.multiline}
                plain={p.expressions === false}
                value={typeof value === "string" ? value : ""}
                invalid={missing}
                onChange={(v) => set(p.name, v)}
              />
            )}

            {p.type === "number" && !expr && (
              <Input
                id={id}
                type="number"
                min={p.min}
                max={p.max}
                value={typeof value === "number" ? value : ""}
                aria-invalid={missing || outOfRange}
                onChange={(e) =>
                  set(p.name, e.target.value === "" ? undefined : Number(e.target.value))
                }
              />
            )}

            {p.type === "boolean" && !expr && (
              <Switch
                id={id}
                checked={value === true}
                onCheckedChange={(checked) => set(p.name, checked)}
              />
            )}

            {p.type === "enum" && !expr && plainOnly && p.name === "color" && (
              <div id={id} role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
                {p.options.map((o) => (
                  <Tip key={o.value} label={optionLabel(o)}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={value === o.value}
                      aria-label={optionLabel(o)}
                      onClick={() => set(p.name, o.value)}
                      className={cn(
                        "focus-visible:ring-ring size-7 rounded-full border-2 border-transparent outline-none focus-visible:ring-2",
                        layoutPalette(o.value).swatch,
                        value === o.value && "ring-foreground ring-offset-background ring-2 ring-offset-2",
                      )}
                    />
                  </Tip>
                ))}
              </div>
            )}

            {p.type === "enum" && !expr && !(plainOnly && p.name === "color") && (
              <Select
                value={typeof value === "string" ? value : ""}
                onValueChange={(v) => set(p.name, v)}
              >
                <SelectTrigger id={id} className="w-full" aria-invalid={missing}>
                  <SelectValue placeholder={t("inspector.select")} />
                </SelectTrigger>
                <SelectContent>
                  {p.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {optionLabel(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {p.type === "multienum" && !expr && (
              <div id={id} role="group" className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
                {p.options.map((o) => {
                  const selected = Array.isArray(value) ? (value as string[]) : [];
                  const k = `paramOptions.${p.name}.${o.value}`;
                  return (
                    <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.includes(o.value)}
                        onCheckedChange={(on) =>
                          set(p.name, on === true ? [...selected, o.value] : selected.filter((x) => x !== o.value))
                        }
                      />
                      {t.has(k) ? t(k) : (o.label ?? o.value)}
                    </label>
                  );
                })}
              </div>
            )}

            {p.type === "json" && (
              <JsonField id={id} value={value} onValid={(v) => set(p.name, v)} register={(f) => (jsonInsert.current[p.name] = f)} plain={p.expressions === false} />
            )}

            {missing && <p className="text-destructive text-xs">{t("inspector.required")}</p>}
            {outOfRange && <p className="text-destructive text-xs">{t("inspector.outOfRange", { range })}</p>}
          </div>
        );
      })}
      {!plainOnly && <p className="text-muted-foreground text-xs">{t("inspector.expressionsHint")}</p>}
    </div>
  );
}
