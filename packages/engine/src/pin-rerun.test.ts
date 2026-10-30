import { registry } from "@fl0w/blocks";
import type { Json, RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { collect, edge, flow, node } from "./test-helpers";

const logs = (events: RunnerEvent[], id: string) => events.flatMap((e) => (e.event === "node:log" && e.nodeId === id ? [e.message] : []));
const ran = (events: RunnerEvent[], id: string) => logs(events, id).includes("ran");
const code = (id: string) => node(id, "code", { code: `log("ran"); return { out0: { by: "${id}", got: inputs.in0 } }` });
const run = (f: ReturnType<typeof flow>, opts: Record<string, unknown> = {}) => collect(f, { registry, ...opts });

/** Source → a → b → c → Result, каждая ступень логирует «ran», когда реально исполняется. */
const chain = (pins: Record<string, Record<string, Json>> = {}) => {
  const nodes = [node("s", "source", { json: { v: 1 } }), code("a"), code("b"), code("c"), node("r", "result")];
  for (const n of nodes) if (pins[n.id]) n.pinData = pins[n.id]!;
  return flow(nodes, [edge("s", "a"), edge("a", "b"), edge("b", "c"), edge("c", "r")]);
};

describe("pin data", () => {
  it("закреплённая нода не исполняется и отдаёт закреплённый выход; остальные идут как обычно", async () => {
    const r = await run(chain({ b: { out0: { fake: true } } }));
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "b")).toBe(false);
    expect(logs(r.events, "b")).toEqual(["pinned data used (node not executed)"]);
    expect(ran(r.events, "c")).toBe(true);
    expect(r.done?.result).toEqual({ by: "c", got: { fake: true } });
  });

  it("закреплённый выход ноды-источника тоже подменяет данные", async () => {
    const r = await run(chain({ s: { out0: { v: 99 } } }));
    expect(r.done?.result).toMatchObject({ by: "c", got: { by: "b", got: { by: "a", got: { v: 99 } } } });
  });

  it("плановые запуски (с trigger) pin игнорируют: опубликованный флоу работает на настоящих данных", async () => {
    const f = flow(
      [{ ...node("w", "webhook", { path: "x" }), pinData: { out0: { fake: 1 } } }, node("r", "result")],
      [edge("w", "r")],
    );
    const r = await run(f, { trigger: "w", triggerData: { real: 1 } });
    expect(r.done?.result).toEqual({ real: 1 });
  });

  it("триггер события с закреплёнными данными стартует в ручном запуске; без закрепления — нет", async () => {
    const mk = (pin?: Record<string, Json>) =>
      flow([{ ...node("w", "webhook", { path: "x" }), ...(pin ? { pinData: pin } : {}) }, node("r", "result")], [edge("w", "r")]);
    const pinned = await run(mk({ out0: { method: "POST", body: { id: 7 } } }));
    expect(pinned.started).toEqual(["w", "r"]);
    expect(pinned.done?.result).toEqual({ method: "POST", body: { id: 7 } });
    const bare = await run(mk());
    expect(bare.started).toEqual([]);
    expect(bare.done?.error).toMatch(/Nothing to start manually/);
  });

  it("узел с закреплением валиден в схеме, лишние данные не ломают флоу", async () => {
    const r = await run(chain({ a: { out0: { x: [1, 2, 3] }, extra: 1 } }));
    expect(r.done?.error).toBeUndefined();
  });
});

describe("перезапуск с ноды (from + seeds)", () => {
  const seeds = { s: { out0: { v: 1 } }, a: { out0: { by: "a-old" } } };

  it("исполняется выбранная нода и всё после неё; предшественники выдают данные прошлого запуска", async () => {
    const r = await run(chain(), { from: "b", seeds });
    expect(ran(r.events, "a")).toBe(false);
    expect(logs(r.events, "a")).toEqual(["data from the previous run used (node not executed)"]);
    expect(ran(r.events, "b")).toBe(true);
    expect(ran(r.events, "c")).toBe(true);
    expect(r.done?.result).toMatchObject({ by: "c", got: { by: "b", got: { by: "a-old" } } });
    // источник s нужен только предшественнику-замороженной ноде a — не запускается и не мешает
    expect(r.started).toContain("r");
  });

  it("нет данных у нужного предшественника — понятная ошибка, ничего лишнего не запускается", async () => {
    const r = await run(chain(), { from: "b", seeds: { s: { out0: { v: 1 } } } });
    expect(r.done?.error).toMatch(/No saved data for node "a"/);
    expect(ran(r.events, "b")).toBe(false);
  });

  it("неизвестная нода — ошибка; перезапуск с первой ноды не требует seeds", async () => {
    expect((await run(chain(), { from: "zzz" })).done?.error).toMatch(/Unknown node "zzz"/);
    const r = await run(chain(), { from: "s" });
    expect(r.done?.error).toBeUndefined();
    expect(ran(r.events, "c")).toBe(true);
  });

  it("закреплённая нода в перезапускаемой части использует pin, а не исполняется", async () => {
    const r = await run(chain({ c: { out0: { pinned: "c" } } }), { from: "a", seeds: { s: { out0: { v: 1 } } } });
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "c")).toBe(false);
    expect(r.done?.result).toEqual({ pinned: "c" });
  });

  it("ветки, не связанные с точкой перезапуска, не запускаются", async () => {
    const f = flow(
      [node("s", "source", { json: { v: 1 } }), code("a"), code("other"), node("r", "result"), node("r2", "result")],
      [edge("s", "a"), edge("a", "r"), edge("s", "other"), edge("other", "r2")],
    );
    const r = await run(f, { from: "a", seeds: { s: { out0: { v: 1 } } } });
    expect(ran(r.events, "a")).toBe(true);
    expect(ran(r.events, "other")).toBe(false);
    expect(r.started).not.toContain("other");
  });

  it("from работает и для флоу с событийными триггерами (данные триггера — из seeds)", async () => {
    const f = flow([node("w", "webhook", { path: "x" }), code("a"), node("r", "result")], [edge("w", "a"), edge("a", "r")]);
    const r = await run(f, { from: "a", seeds: { w: { out0: { body: { id: 1 } } } } });
    expect(r.done?.result).toEqual({ by: "a", got: { body: { id: 1 } } });
  });

  it("большие данные seeds усекаются в событии, но по рёбрам идут целиком", async () => {
    const big = "x".repeat(200_000);
    const r = await run(chain(), { from: "b", seeds: { s: { out0: { v: 1 } }, a: { out0: { big } } } });
    expect(JSON.stringify(r.done?.result)).toContain(big.slice(0, 1000));
    const done = r.events.find((e) => e.event === "node:done" && e.nodeId === "a");
    expect(JSON.stringify(done).length).toBeLessThan(60_000);
  });
});
