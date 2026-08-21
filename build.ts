import { spawnSync } from "node:child_process";
import { join } from "node:path";
import "./scripts/clean-generated.ts";

const tsc = join("node_modules", "typescript", "bin", "tsc");
const result = spawnSync("node", [tsc, "-p", "tsconfig.npm.json"], {
  stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Replaces the multi-file output tsc just wrote for `knitting.browser.ts` with
// a bundle; its `.d.ts` stays. `npm run build:browser` emits a readable copy.
const browser = spawnSync("bun", [
  join("scripts", "build-browser.ts"),
  "--out",
  ".",
  "--only-minified",
], { stdio: "inherit" });

if (browser.error !== undefined) throw browser.error;
if (browser.status !== 0) process.exit(browser.status ?? 1);
