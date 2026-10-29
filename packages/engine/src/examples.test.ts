import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registry } from "@fl0w/blocks";
import type { RunnerEvent } from "@fl0w/schema";
import { describe, expect, it } from "vitest";
import { runFlowInProcess } from "./spawn";
import { validateFlow } from "./validate";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

const load = (file: string): unknown => JSON.parse(readFileSync(path.join(dir, file), "utf8"));

async function run(file: string) {
  const checked = validateFlow(load(file), registry);
  if (!checked.ok) throw new Error(checked.issues.map((i) => i.message).join("; "));
  const events: RunnerEvent[] = [];
  await runFlowInProcess(checked.flow, (e) => events.push(e), { timeoutMs: 20000 });
  return events;
}

describe("examples/*.json", () => {
  it("есть примеры", () => {
    expect(files.sort()).toEqual(["demo.json", "showcase.json"]);
  });

  it.each(files)("%s проходит валидацию", (file) => {
    const r = validateFlow(load(file), registry);
    expect(r.ok, r.ok ? "" : r.issues.map((i) => i.message).join("; ")).toBe(true);
  });

  it("demo.json: Source → Transform → Transform → Result", async () => {
    expect((await run("demo.json")).at(-1)).toEqual({
      event: "flow:done",
      result: [{ who: "ann" }, { who: "cat" }],
    });
  });

  it("showcase.json: ветвление, Merge, лог кода; невзятая ветка пропущена", async () => {
    const events = await run("showcase.json");
    expect(events.at(-1)).toEqual({
      event: "flow:done",
      result: {
        res_big: { label: "big", sum: 250 },
        res_merged: { name: "Ann", visits: 12 },
      },
    });
    const started = events.flatMap((e) => (e.event === "node:start" ? [e.nodeId] : []));
    expect(started).not.toContain("label_small");
    expect(started).not.toContain("res_small");
    expect(events).toContainEqual({ event: "node:log", nodeId: "totals", message: "orders: 3 sum: 250" });
  });
});
