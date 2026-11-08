import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@fl0w/schema";
import { runFlowInProcess, type ProcessRunOptions } from "./spawn";
import { edge, flow, node } from "./test-helpers";

const demo = flow(
  [node("src", "source", { json: { n: 1 } }), node("res", "result")],
  [edge("src", "res")],
);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fl0w-spawn-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake runner is a plain .mjs, hence no tsx (execArgv: []). */
function fake(name: string, body: string): ProcessRunOptions {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(file, `process.once("message", async () => {\n${body}\n});\n`);
  return { runnerPath: file, execArgv: [] };
}

async function run(opts: ProcessRunOptions = {}, f = demo) {
  const events: RunnerEvent[] = [];
  await runFlowInProcess(f, (e) => events.push(e), opts);
  return { events, done: events.filter((e) => e.event === "flow:done") };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runFlowInProcess (real runner)", () => {
  it("Source → Result demo: result and per-node events", async () => {
    const { events, done } = await run();
    expect(events.map((e) => (e.event === "flow:done" ? e.event : "nodeId" in e ? `${e.event}:${e.nodeId}` : e.event))).toEqual([
      "node:start:src",
      "node:done:src",
      "node:start:res",
      "node:done:res",
      "flow:done",
    ]);
    expect(done).toEqual([{ event: "flow:done", result: { n: 1 } }]);
  });

  it("invalid flow: an error in flow:done, no node events, the runner does not crash", async () => {
    const cyc = flow(
      [node("a", "result"), node("b", "result")],
      [edge("a", "b"), edge("b", "a")],
    );
    const { events } = await run({}, cyc);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "flow:done" });
    expect(events[0]!.event === "flow:done" && events[0]!.error).toMatch(/Invalid flow/);
  });

  it("every run is a new process, independent of the parent", async () => {
    const pids = [1, 2].map(() => 0);
    for (let i = 0; i < 2; i++) {
      const { events } = await run(
        fake(
          `pid${i}`,
          `process.send({ event: "node:done", nodeId: "x", output: { pid: process.pid } });
           process.send({ event: "flow:done" }); setTimeout(() => process.exit(0), 20);`,
        ),
      );
      const out = events.find((e) => e.event === "node:done");
      pids[i] = out?.event === "node:done" ? (out.output["pid"] as number) : 0;
    }
    expect(pids[0]).not.toBe(process.pid);
    expect(pids[1]).not.toBe(process.pid);
    expect(pids[0]).not.toBe(pids[1]);
  });
});

describe("runFlowInProcess (resilience)", () => {
  it("a process crash → flow:done with an error and the stderr tail", async () => {
    const { done } = await run(fake("crash", `console.error("boom details"); process.exit(3);`));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ event: "flow:done" });
    const err = done[0]!.event === "flow:done" ? done[0]!.error : "";
    expect(err).toMatch(/exited unexpectedly \(code 3\)/);
    expect(err).toMatch(/boom details/);
  });

  it("a malformed event → protocol error, the process is killed", async () => {
    const { done } = await run(
      fake("bad", `process.send({ event: "nonsense" }); setInterval(() => {}, 1000);`),
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ error: expect.stringMatching(/protocol error/) });
  });

  it("exactly one flow:done, even if the runner sends extra events after it", async () => {
    const { events } = await run(
      fake(
        "dup",
        `process.send({ event: "flow:done", result: 1 });
         process.send({ event: "flow:done", result: 2 });
         process.send({ event: "node:start", nodeId: "late" });
         setTimeout(() => process.exit(0), 50);`,
      ),
    );
    expect(events).toEqual([{ event: "flow:done", result: 1 }]);
  });

  it("cancellation kills the process and finishes the run", async () => {
    const ac = new AbortController();
    const opts = {
      ...fake(
        "hang",
        `process.send({ event: "node:start", nodeId: String(process.pid) }); setInterval(() => {}, 1000);`,
      ),
      signal: ac.signal,
    };
    const events: RunnerEvent[] = [];
    const p = runFlowInProcess(demo, (e) => {
      events.push(e);
      if (e.event === "node:start") ac.abort();
    }, opts);
    await p;

    const started = events.find((e) => e.event === "node:start");
    const pid = Number(started?.event === "node:start" ? started.nodeId : 0);
    expect(events.at(-1)).toEqual({ event: "flow:done", error: "Aborted" });
    expect(events.filter((e) => e.event === "flow:done")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it("timeoutMs kills a hung process", async () => {
    const t = Date.now();
    const { done } = await run({
      ...fake("hang2", `setInterval(() => {}, 1000);`),
      timeoutMs: 150,
    });
    expect(done).toEqual([{ event: "flow:done", error: "Run timed out after 150 ms" }]);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("an already aborted signal: the process does not start", async () => {
    const ac = new AbortController();
    ac.abort();
    const { events } = await run({ signal: ac.signal });
    expect(events).toEqual([{ event: "flow:done", error: "Aborted" }]);
  });

  it("a nonexistent runner → a clear error, not a hang", async () => {
    const { done } = await run({ runnerPath: path.join(dir, "missing.mjs"), execArgv: [] });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ error: expect.stringMatching(/Runner exited unexpectedly/) });
  });
});

/** Waits for a condition by polling (runner start through tsx takes varying time under load). */
async function until(cond: () => boolean, ms = 20_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for a runner event");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("run pause (real runner)", () => {
  const slow = flow(
    [node("src", "source", { json: { n: 1 } }), node("w", "wait", { unit: "seconds", amount: 0.15 }), node("res", "result")],
    [edge("src", "w"), edge("w", "res")],
  );

  it("pause stops the next node from starting, the running one finishes; resuming completes the run", async () => {
    const events: RunnerEvent[] = [];
    let ctl: { pause: () => void; resume: () => void } | undefined;
    const finished = runFlowInProcess(
      slow,
      (e) => {
        events.push(e);
        if (e.event === "node:start" && e.nodeId === "w") ctl!.pause();
      },
      { onControl: (c) => (ctl = c) },
    );
    await until(() => events.some((e) => e.event === "node:done" && e.nodeId === "w") && events.some((e) => e.event === "run:paused"));
    await new Promise((r) => setTimeout(r, 300)); // give the next node a chance to (wrongly) start
    const names = events.map((e) => e.event + ("nodeId" in e ? `:${e.nodeId}` : ""));
    expect(names).toContain("run:paused");
    expect(names).toContain("node:done:w");
    expect(names).not.toContain("node:start:res");
    expect(events.some((e) => e.event === "flow:done")).toBe(false);
    ctl!.resume();
    await finished;
    expect(events.at(-1)).toMatchObject({ event: "flow:done" });
    expect(events.map((e) => e.event === "node:start" && e.nodeId)).toContain("res");
  });

  it("stopping while paused finishes the run with an Aborted error", async () => {
    const ac = new AbortController();
    const events: RunnerEvent[] = [];
    let ctl: { pause: () => void; resume: () => void } | undefined;
    const finished = runFlowInProcess(
      slow,
      (e) => {
        events.push(e);
        if (e.event === "node:start" && e.nodeId === "w") ctl!.pause();
      },
      { onControl: (c) => (ctl = c), signal: ac.signal },
    );
    await until(() => events.some((e) => e.event === "run:paused"));
    ac.abort();
    await finished;
    expect(events.at(-1)).toMatchObject({ event: "flow:done", error: "Aborted" });
  });
});
