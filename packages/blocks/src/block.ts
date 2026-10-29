import type { Json, ParamSchema, PortsDef } from "@fl0w/schema";

export interface RunContext {
  log(msg: string): void;
  signal: AbortSignal;
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
