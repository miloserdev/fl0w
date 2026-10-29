import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";

export interface RunContext {
  log(msg: string): void;
  signal: AbortSignal;
  /** Данные, с которыми сработал триггер этой ноды (например, запрос вебхука); у остальных нод нет. */
  triggerData?: Json;
}

/**
 * Базовый класс блока. Изоморфен: на уровне модуля — никаких node-only
 * или browser-only импортов (они допустимы только внутри тела run).
 */
export abstract class Block {
  static type: string;
  static label: string;
  static icon: string;
  static category: string;
  static ports: PortsDef;
  static params: ParamSchema[];
  static defaultCss = "";
  /** Триггер: нода без входов, с которой стартует запуск (по расписанию или вручную). */
  static isTrigger = false;
  /**
   * Триггер срабатывает сам (по расписанию или входящему запросу), без участия человека.
   * Опубликованный флоу без таких триггеров никогда не запустится, поэтому публикация требует хотя бы один.
   */
  static autoTrigger = false;
  /** Для триггеров-вебхуков: на какой путь и метод слушать; null — нода не вебхук. */
  static webhook(_params: Record<string, Json>): { path: string; method: string } | null {
    return null;
  }
  /** Для триггеров с расписанием: период срабатывания в мс; null — расписания нет. */
  static intervalMs(_params: Record<string, Json>): number | null {
    return null;
  }
  /** d.ts окружения для автокомплита в редакторе кода (только у блоков с `editor: "code"` параметром). */
  static codeTypes = "";

  abstract run(
    inputs: Record<string, Json>,
    params: Record<string, Json>,
    ctx: RunContext,
  ): Promise<Record<string, Json>>;
}
