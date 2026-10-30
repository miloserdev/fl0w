"use client";

import { useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { hasTemplate, splitSegments, type Segment } from "./expression-segments";

const KIND_CLASS: Record<Segment["kind"], string> = {
  text: "",
  inputs: "rounded-sm bg-primary/20",
  relative: "rounded-sm bg-muted-foreground/25",
  open: "rounded-sm bg-primary/10",
};

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  /** принудительно «режим выражения» (поле числа/списка в виде выражения), даже если шаблона в тексте нет */
  forceExpression?: boolean;
  /** выражения не поддерживаются (`expressions: false`): без подсветки */
  plain?: boolean;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
};

/**
 * Текстовое поле с подсветкой фрагментов `{{ … }}`. Настоящий <input>/<textarea> лежит поверх «зеркала» с тем же
 * текстом: зеркало рисует только цветные подложки (его текст прозрачен), а текст, курсор, выделение и IME остаются
 * нативными — поэтому небольшое расхождение метрик не ломает ввод. Прокрутка зеркала синхронизируется с полем.
 */
export function ExpressionField({ id, value, onChange, multiline, forceExpression, plain, placeholder, invalid, className }: Props) {
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const active = !plain && (forceExpression || hasTemplate(value));
  const segments = plain ? [] : splitSegments(value);

  const sync = () => {
    const el = fieldRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  };
  useLayoutEffect(sync, [value]);

  const common = cn(
    "relative bg-transparent",
    active && "border-primary/60 ring-1 ring-primary/25",
    (active || multiline) && "font-mono text-xs md:text-xs",
    className,
  );
  const handlers = {
    id,
    value,
    placeholder,
    spellCheck: false,
    "aria-invalid": invalid || undefined,
    "data-expression": active ? "true" : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onScroll: sync,
    onSelect: sync,
    onKeyUp: sync,
  };

  return (
    <div className="relative">
      <div
        aria-hidden
        data-slot="expression-mirror"
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent px-3 text-base text-transparent",
          multiline ? "py-2" : "flex items-center py-1",
          (active || multiline) && "font-mono text-xs md:text-xs",
          !(active || multiline) && "md:text-sm",
        )}
      >
        <div ref={innerRef} className={multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>
          {segments.map((s, i) => (
            <span key={i} className={KIND_CLASS[s.kind]}>
              {s.text}
            </span>
          ))}
          {multiline && "\n"}
        </div>
      </div>
      {multiline ? (
        <Textarea ref={fieldRef as never} {...handlers} className={cn("min-h-32", common)} />
      ) : (
        <Input ref={fieldRef as never} {...handlers} className={common} />
      )}
    </div>
  );
}
