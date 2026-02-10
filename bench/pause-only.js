const seconds = Number(globalThis.process?.env?.SECONDS ?? globalThis.Deno?.env.get("SECONDS") ?? "8");
const pauseNs = Number(
  globalThis.process?.env?.PAUSE_NS ?? globalThis.Deno?.env.get("PAUSE_NS") ?? "2000000000",
);

if (typeof Atomics.pause !== "function") {
  throw new Error("Atomics.pause is not available in this runtime");
}

const runtime = (() => {
  if (typeof Bun !== "undefined") return `bun ${Bun.version}`;
  if (typeof Deno !== "undefined") return `deno ${Deno.version.deno}`;
  if (typeof process !== "undefined") return `node ${process.version}`;
  return "unknown";
})();

const deadline = Date.now() + seconds * 1000;
let iterations = 0;

while (Date.now() < deadline) {
  Atomics.pause(pauseNs);
  iterations++;
}

console.log(
  JSON.stringify({
    runtime,
    seconds,
    pauseNs,
    iterations,
  }),
);
