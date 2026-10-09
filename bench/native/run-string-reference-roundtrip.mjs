import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
const runtimes = {
  node: [process.env.STRING_NODE_BINARY ?? process.execPath, ["--no-warnings", "--experimental-transform-types", "--expose-gc"]],
  deno: [process.env.STRING_DENO_BINARY ?? "deno", ["run", "-A", "--v8-flags=--expose-gc"]],
  bun: [process.env.STRING_BUN_BINARY ?? "bun", []],
};
const destination = process.env.STRING_RESULTS_DIR ?? "results/string-reference-roundtrip";
const repetitions = Number(process.env.REPETITIONS ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("REPETITIONS must be a positive integer");
mkdirSync(destination, { recursive: true });
const captures = [];
for (const name of (process.env.RUNTIMES ?? "node,deno,bun").split(",")) {
  if (!runtimes[name]) throw new Error(`Unknown runtime ${name}`);
  const [binary, flags] = runtimes[name];
  for (let i = 0; i < repetitions; i++) {
    const child = spawnSync(binary, [...flags, "bench/native/string-reference-roundtrip.ts"], {
      encoding: "utf8", env: { ...process.env, ROUNDS: process.env.ROUNDS ?? "100", WARMUP: process.env.WARMUP ?? "30" },
      maxBuffer: 10 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(`${name} failed: ${child.stderr}`);
    const result = JSON.parse(child.stdout.trim());
    captures.push(result);
    writeFileSync(`${destination}/${name}-${i + 1}.json`, JSON.stringify(result, null, 2) + "\n");
    console.log(`${result.runtime}, run ${i + 1}: verified; ${result.stats.entries} handles remaining`);
  }
}
const groups = new Map();
for (const capture of captures) for (const row of capture.rows) {
  const key = `${capture.runtime}/${row.bytes}/${row.kind}/${row.mode}`;
  if (!groups.has(key)) groups.set(key, { runtime: capture.runtime, ...row, samples: [] });
  groups.get(key).samples.push(row.p50_us);
}
const rows = [...groups.values()].map(({ samples, ...row }) => {
  samples.sort((a, b) => a - b);
  return { ...row, p50_us: samples[Math.floor(samples.length / 2)] };
});
writeFileSync(`${destination}/summary.json`, JSON.stringify({ repetitions, rows, captures: captures.map(({ rows, ...rest }) => rest) }, null, 2) + "\n");
