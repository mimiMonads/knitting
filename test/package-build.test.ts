import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "./_runner.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const isBun = typeof process.versions.bun === "string";
const packageBuildTest = isBun ? test.skip : test;
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = join(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

const run = (args: string[]) => {
  const command = existsSync(npmCli) ? process.execPath : npmBin;
  const commandArgs = existsSync(npmCli) ? [npmCli, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: !existsSync(npmCli) && process.platform === "win32",
  });
  assert.equal(
    result.status,
    0,
    `${command} ${commandArgs.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
};

const parsePackFiles = (stdout: string): Set<string> => {
  const packed = JSON.parse(stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  assert.equal(packed.length, 1);
  return new Set(packed[0]!.files.map((file) => file.path));
};

const visit = (dir: string, predicate: (path: string) => void): void => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      visit(path, predicate);
      continue;
    }
    predicate(path);
  }
};

packageBuildTest("npm package build ships compiled source files and compatibility entries", {
  concurrency: false,
  timeout: 60_000,
}, () => {
  run(["run", "build:npm"]);

  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as {
    exports: Record<string, unknown>;
  };
  assert.ok(packageJson.exports["./process-shared-buffer"]);
  assert.ok(packageJson.exports["./shared-memory"]);

  const rootEntrypoint = readFileSync(join(root, "knitting.js"), "utf8");
  assert.match(rootEntrypoint, /from "\.\/src\/api\.js"/);
  assert.match(rootEntrypoint, /from "\.\/src\/worker\/loop\.js"/);

  for (const expected of [
    "knitting.js",
    "knitting.d.ts",
    "process-shared-buffer.js",
    "process-shared-buffer.d.ts",
    "shared-memory.js",
    "shared-memory.d.ts",
    "unsafe.js",
    "unsafe.d.ts",
    "utils.js",
    "utils.d.ts",
    "src/api.js",
    "src/api.d.ts",
    "src/runtime/pool.js",
    "src/runtime/pool.d.ts",
    "src/worker/loop.js",
    "src/worker/loop.d.ts",
    "src/connections/package-assets.js",
    "src/connections/package-assets.d.ts",
    "src/connections/node-ffi.js",
    "src/connections/node-ffi.d.ts",
    "src/connections/external-array-buffer.js",
    "src/connections/external-array-buffer.d.ts",
    "src/connections/process-shared-buffer.js",
    "src/connections/process-shared-buffer.d.ts",
  ]) {
    assert.equal(existsSync(join(root, expected)), true, `${expected} exists`);
  }

  visit(join(root, "src"), (path) => {
    if (!path.endsWith(".d.ts")) return;
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /\.ts(?=["')])/,
      `${path} should not reference TypeScript source extensions`,
    );
  });
  for (const file of [
    "knitting.d.ts",
    "process-shared-buffer.d.ts",
    "shared-memory.d.ts",
    "unsafe.d.ts",
    "utils.d.ts",
  ]) {
    assert.doesNotMatch(
      readFileSync(join(root, file), "utf8"),
      /\.ts(?=["')])/,
      `${file} should not reference TypeScript source extensions`,
    );
  }

  const files = parsePackFiles(
    run(["pack", "--dry-run", "--json", "--ignore-scripts"]),
  );
  for (const expected of [
    "process-shared-buffer.js",
    "process-shared-buffer.d.ts",
    "shared-memory.js",
    "shared-memory.d.ts",
    "src/api.js",
    "src/api.d.ts",
    "src/runtime/pool.js",
    "src/runtime/pool.d.ts",
    "src/worker/loop.js",
    "src/worker/loop.d.ts",
    "src/connections/package-assets.js",
    "src/connections/package-assets.d.ts",
  ]) {
    assert.equal(files.has(expected), true, `${expected} is packed`);
  }
});
