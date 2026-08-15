import { spawnSync } from "node:child_process";
import { join } from "node:path";
import "./scripts/clean-generated.ts";

const tsc = join("node_modules", "typescript", "bin", "tsc");
const result = spawnSync("node", [tsc, "-p", "tsconfig.npm.json"], {
  stdio: "inherit",
});

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
