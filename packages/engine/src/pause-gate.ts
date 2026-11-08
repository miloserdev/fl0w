/**
  * Run pause: while it is on, the scheduler does not start NEW nodes; ones already running finish (they cannot be frozen: Wait, HTTP…).
  * One gate per whole run; nested runs (loop bodies, flow calls) receive it too.
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

  /** Waits for the pause to be lifted or for cancellation. */
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
