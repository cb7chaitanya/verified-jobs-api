// Copies the benchmark results from ../bench/results into data/bench so the site builds on its own
// (Vercel builds only this folder). Run after a new benchmark: pnpm sync-data
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "../../bench/results");
const to = join(here, "../data/bench");
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from).filter((n) => n.endsWith(".json"))) {
  copyFileSync(join(from, f), join(to, f));
  console.log("copied", f);
}
