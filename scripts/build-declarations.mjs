import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = process.platform === "win32"
  ? "node_modules/.bin/dts-bundle-generator.cmd"
  : "node_modules/.bin/dts-bundle-generator";

const entries = [
  ["knitting.ts", "knitting.d.ts"],
  ["shared-memory.ts", "shared-memory.d.ts"],
  ["unsafe.ts", "unsafe.d.ts"],
  ["utils.ts", "utils.d.ts"],
];

rmSync(new URL("../process-shared-buffer.d.ts", import.meta.url), {
  force: true,
});

for (const [entry, output] of entries) {
  const result = spawnSync(
    binary,
    [
      "--project",
      "tsconfig.npm.json",
      "--no-banner",
      "--no-check",
      "--export-referenced-types",
      "false",
      "--out-file",
      output,
      entry,
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
