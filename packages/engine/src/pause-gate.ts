/**
 * Пауза запуска: пока она включена, планировщик не стартует НОВЫЕ ноды; уже работающие доделываются (их не заморозить: Wait, HTTP…).
 * Один затвор на весь запуск — его получают и вложенные (тела циклов, вызовы флоу).
 */
export class PauseGate {
  private on = false;
  private waiters = new Set<() => void>();

  get paused(): boolean {
    return this.on;
  }

  pause(): void {
    this.on = true;
  }

  resume(): void {
    if (!this.on) return;
    this.on = false;
    this.wake();
  }

  /** Ждёт снятия паузы или отмены. */
  untilResumed(signal?: AbortSignal): Promise<void> {
    if (!this.on || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
