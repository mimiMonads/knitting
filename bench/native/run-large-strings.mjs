import process from "node:process";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(
  root,
  process.env.STRING_RESULTS_DIR ?? "results/large-strings/cross-runtime",
);
mkdirSync(output, { recursive: true });
const repetitions = Number(process.env.REPETITIONS ?? 3);
if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
  throw new Error("Invalid REPETITIONS");
}
const runtimes = [
  ["node", process.env.STRING_NODE_BINARY ?? process.execPath, [
    "--expose-gc",
    "--experimental-transform-types",
    "--no-warnings",
  ]],
  ["deno", process.env.STRING_DENO_BINARY ?? "deno", [
    "run",
    "-A",
    "--v8-flags=--expose-gc",
  ]],
  ["bun", process.env.STRING_BUN_BINARY ?? "bun", []],
];
const selected = (process.env.RUNTIMES ?? "node,deno,bun").split(",");
const workloads = (process.env.WORKLOADS ?? "sample,scan").split(",");
if (
  selected.some((runtime) => !runtimes.some(([name]) => name === runtime)) ||
  workloads.some((workload) => !["sample", "scan"].includes(workload))
) {
  throw new Error("Unknown RUNTIMES or WORKLOADS entry");
}
const captures = [];
for (const workload of workloads) {
  for (const [runtime, executable, flags] of runtimes) {
    if (!selected.includes(runtime)) continue;
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      console.log(
        `${runtime}/${workload}: repetition ${repetition}/${repetitions}`,
      );
      const stdout = await new Promise((resolveRun, reject) => {
        const child = spawn(executable, [
          ...flags,
          "bench/native/large-strings.ts",
          "--json",
        ], {
          cwd: root,
          env: {
            ...process.env,
            STRING_BACKEND: runtime === "node" ? "v8" : "napi",
            VARIANTS: "plain-string,native-transparent",
            SIZE_UNIT: "bytes",
            SIZES: "1024,65536,1048576",
            KINDS: "ascii,latin1,utf16,emoji",
            WORKLOAD: workload,
            ROUNDS: workload === "scan" ? "100" : "500",
            WARMUP: workload === "scan" ? "50" : "150",
          },
        });
        let data = "";
        let errors = "";
        child.stdout.on("data", (part) => {
          data += part;
        });
        child.stderr.on("data", (part) => {
          errors += part;
        });
        child.on("error", reject);
        child.on(
          "close",
          (code) =>
            code === 0 ? resolveRun(data) : reject(
              new Error(`${runtime}/${workload} exited ${code}: ${errors}`),
            ),
        );
      });
      const capture = JSON.parse(stdout);
      if (
        capture.nativeLifetime.entries !== 0 ||
        capture.nativeLifetime.liveBytes !== 0
      ) {
        throw new Error("Native storage was not reclaimed");
      }
      writeFileSync(
        resolve(output, `${runtime}-${workload}-${repetition}.json`),
        stdout,
      );
      captures.push(capture);
    }
  }
}
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const groups = new Map();
for (const capture of captures) {
  for (const row of capture.rows) {
    const key = JSON.stringify([
      capture.runtime,
      capture.backend,
      capture.workload,
      row.kind,
      row.size,
    ]);
    const group = groups.get(key) ??
      {
        runtime: capture.runtime,
        backend: capture.backend,
        workload: capture.workload,
        kind: row.kind,
        utf8Bytes: row.size,
        variants: {},
      };
    (group.variants[row.variant] ??= []).push(row.p50_us);
    groups.set(key, group);
  }
}
const rows = [...groups.values()].map((group) => {
  const current = group.variants["plain-string"];
  const native = group.variants["native-transparent"];
  return {
    runtime: group.runtime,
    backend: group.backend,
    workload: group.workload,
    kind: group.kind,
    utf8Bytes: group.utf8Bytes,
    current_us: median(current),
    native_us: median(native),
    speedup: median(current) / median(native),
    current_run_min_us: Math.min(...current),
    current_run_max_us: Math.max(...current),
    native_run_min_us: Math.min(...native),
    native_run_max_us: Math.max(...native),
  };
});
const summary = {
  metric: "median of independent run p50 call latency, microseconds",
  repetitions,
  rows,
};
writeFileSync(
  resolve(output, "summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(`Saved validated captures and summary to ${output}`);
