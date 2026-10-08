import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "./_runner.ts";

const runner = fileURLToPath(new URL("../run.sh", import.meta.url));
const options = { skip: process.platform === "win32" };

const withHarness = (
  check: (harness: {
    run: (mode?: string, extra?: string[]) => ReturnType<typeof spawnSync>;
    result: string;
  }) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "knitting-bench-runner-"));
  const benches = join(root, "benches");
  const bin = join(root, "bin");
  const results = join(root, "results");
  mkdirSync(benches);
  mkdirSync(bin);
  for (
    const name of [
      "a.ts",
      "b.ts",
      "http-body-server.ts",
      "http-body-oha.ts",
      "README.md",
    ]
  ) {
    writeFileSync(join(benches, name), "");
  }
  writeFileSync(
    join(bin, "deno"),
    `#!/bin/sh
echo 'runtime diagnostic' >&2
case "$BENCH_TEST_MODE" in
  failure) echo '{"partial":true}'; exit 1 ;;
  invalid) echo 'not JSON' ;;
  *) echo '{"ok":true}' ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    check({
      run: (mode = "success", extra = []) =>
        spawnSync("bash", [
          runner,
          "--json",
          "--runtime=deno",
          `--bench-dir=${benches}`,
          `--results-dir=${results}`,
          ...extra,
        ], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            BENCH_TEST_MODE: mode,
          },
        }),
      result: join(results, "json", "deno", "deno_a.json"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test(
  "benchmark runner sorts finite scripts and separates stderr from JSON",
  options,
  () => {
    withHarness(({ run, result }) => {
      const outcome = run();
      assert.equal(outcome.status, 0, String(outcome.stderr));
      const stdout = String(outcome.stdout);
      assert.ok(stdout.indexOf("a.ts") < stdout.indexOf("b.ts"));
      assert.ok(!stdout.includes("http-body"));
      assert.ok(!stdout.includes("README"));
      assert.deepEqual(JSON.parse(readFileSync(result, "utf8")), { ok: true });
      assert.match(
        readFileSync(result.replace(".json", ".stderr.log"), "utf8"),
        /runtime diagnostic/,
      );
    });
  },
);

test(
  "benchmark runner rejects failed or malformed results without replacing a valid capture",
  options,
  () => {
    withHarness(({ run, result }) => {
      assert.equal(run().status, 0);
      const previous = readFileSync(result, "utf8");
      for (const mode of ["failure", "invalid"]) {
        const outcome = run(mode, ["--bench=a"]);
        assert.notEqual(outcome.status, 0);
        assert.equal(readFileSync(result, "utf8"), previous);
        assert.ok(existsSync(`${result}.tmp`));
      }
    });
  },
);

test("benchmark runner rejects an unknown selection", options, () => {
  withHarness(({ run }) => {
    const outcome = run("success", ["--bench=missing"]);
    assert.notEqual(outcome.status, 0);
    assert.match(String(outcome.stderr), /No finite benchmarks selected/);
  });
});
