"use client";

import { hasExpression, isParamVisible, resolveParams } from "@fl0w/blocks";
import type { Json, ParamSchema } from "@fl0w/schema";
import { useTranslations } from "next-intl";
import { Braces } from "lucide-react";
import { useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

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
}: {
  id: string;
  value: Json | undefined;
  onValid: (v: Json) => void;
}) {
  const t = useTranslations("inspector");
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [invalid, setInvalid] = useState(false);

  return (
    <>
      <Textarea
        id={id}
        value={text}
        spellCheck={false}
        aria-invalid={invalid}
        className="min-h-28 font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value);
          try {
            onValid(JSON.parse(e.target.value) as Json);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <p className="text-destructive text-xs">{t("invalidJson")}</p>}
    </>
  );
}

/** Авто-UI настроек блока из `class.params`. */
/** Типы, у которых виджет не принимает текст: для выражения нужен переключатель в текстовый режим. */
const TOGGLEABLE = ["number", "boolean", "enum", "multienum"];

export function ParamForm({ blockType, schema, values, onChange }: Props) {
  const t = useTranslations();
  // режим «выражение» держится, пока поле редактируют: иначе виджет сменился бы обратно, как только в тексте
  // не осталось `{{ }}` (например, при стирании)
  const [exprMode, setExprMode] = useState<Record<string, boolean>>({});

  // параметры с editor: "code" правятся во вкладке кода, а не в форме
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
        const toggleable = TOGGLEABLE.includes(p.type);
        const expr = toggleable && (exprMode[p.name] ?? hasExpression(value));
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
              </Label>
              {p.type === "string" && p.expressions !== false && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  title={t("inspector.insertExpression")}
                  aria-label={t("inspector.insertExpression")}
                  // вставка шаблона из входа в конец текста: можно смешивать с обычным текстом
                  onClick={() => set(p.name, `${typeof value === "string" ? value : ""}{{ inputs.in0. }}`)}
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
              <Input
                id={id}
                value={typeof value === "string" ? value : ""}
                spellCheck={false}
                placeholder="{{ inputs.in0.field }}"
                className="font-mono text-xs"
                onChange={(e) => set(p.name, e.target.value)}
              />
            )}

            {p.type === "string" && p.multiline && (
              <Textarea
                id={id}
                value={typeof value === "string" ? value : ""}
                spellCheck={false}
                aria-invalid={missing}
                className="min-h-32 font-mono text-xs"
                onChange={(e) => set(p.name, e.target.value)}
              />
            )}

            {p.type === "string" && !p.multiline && (
              <Input
                id={id}
                value={typeof value === "string" ? value : ""}
                aria-invalid={missing}
                onChange={(e) => set(p.name, e.target.value)}
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

            {p.type === "enum" && !expr && (
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
              <JsonField id={id} value={value} onValid={(v) => set(p.name, v)} />
            )}

            {missing && <p className="text-destructive text-xs">{t("inspector.required")}</p>}
            {outOfRange && <p className="text-destructive text-xs">{t("inspector.outOfRange", { range })}</p>}
          </div>
        );
      })}
      <p className="text-muted-foreground text-xs">{t("inspector.expressionsHint")}</p>
    </div>
  );
}
