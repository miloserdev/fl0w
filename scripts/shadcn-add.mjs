#!/usr/bin/env node
// Adds shadcn/ui components to apps/web/src/components/ui directly from the registry.
// Needed because `npx shadcn add` fails on network requests in this environment ("other side closed").
// Usage: node scripts/shadcn-add.mjs button dialog   (style new-york-v4, as in components.json)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "apps/web/src/components/ui");
const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: node scripts/shadcn-add.mjs <component> [...]");
  process.exit(2);
}

mkdirSync(dest, { recursive: true });
const npmDeps = new Set();
for (const name of names) {
  const res = await fetch(`https://ui.shadcn.com/r/styles/new-york-v4/${name}.json`);
  if (!res.ok) {
    console.error(`${name}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const item = await res.json();
  for (const file of item.files) {
    const out = path.join(dest, path.basename(file.path));
    // the registry writes imports through registry aliases; rewrite them to the project's aliases
    const content = file.content
      .replaceAll('from "cn"', 'from "@/lib/utils"')
      .replaceAll("@/registry/new-york-v4/ui/", "@/components/ui/");
    writeFileSync(out, content);
    console.log(`wrote ${path.relative(root, out)}`);
  }
  for (const d of item.dependencies ?? []) if (d !== "cn") npmDeps.add(d);
  for (const d of item.registryDependencies ?? []) console.log(`  also needs component: ${d} (run again with that name)`);
}
if (npmDeps.size) console.log(`npm dependencies to ensure: pnpm --filter @fl0w/web add ${[...npmDeps].join(" ")}`);
