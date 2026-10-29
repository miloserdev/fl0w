"use client";

import type { Json, ParamSchema } from "@fl0w/schema";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
export function ParamForm({ blockType, schema, values, onChange }: Props) {
  const t = useTranslations();

  // параметры с editor: "code" правятся во вкладке кода, а не в форме
  const fields = schema.filter((p) => p.editor !== "code");

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
            <Label htmlFor={id}>
              {label}
              {p.required && <span className="text-destructive">*</span>}
            </Label>

            {p.type === "string" && (
              <Input
                id={id}
                value={typeof value === "string" ? value : ""}
                aria-invalid={missing}
                onChange={(e) => set(p.name, e.target.value)}
              />
            )}

            {p.type === "number" && (
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

            {p.type === "boolean" && (
              <Switch
                id={id}
                checked={value === true}
                onCheckedChange={(checked) => set(p.name, checked)}
              />
            )}

            {p.type === "enum" && (
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

            {p.type === "json" && (
              <JsonField id={id} value={value} onValid={(v) => set(p.name, v)} />
            )}

            {missing && <p className="text-destructive text-xs">{t("inspector.required")}</p>}
            {outOfRange && <p className="text-destructive text-xs">{t("inspector.outOfRange", { range })}</p>}
          </div>
        );
      })}
    </div>
  );
}
