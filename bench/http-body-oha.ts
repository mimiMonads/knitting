/**
 * End-to-end load test of the HTTP body -> shared memory strategies, driven by
 * `oha` against a real bun server (`bench/http-body-server.ts`).
 *
 * The point of driving it from outside is that a handler timer cannot see the
 * costs that decide this: body arrival, backpressure, GC, and the allocator
 * under genuine concurrency rather than one request at a time.
 *
 * Needs `oha` on PATH (https://github.com/hatoo/oha).
 *
 *   bun run bench/http-body-oha.ts
 *   OHA_DURATION=20s OHA_CONNECTIONS=100 bun run bench/http-body-oha.ts
 *   OHA_ROUTES=/arrayBuffer,/streamRegion OHA_SIZES=262144 bun run ...
 *
 * Size the pool for the load: `KNITTING_WINDOW` must hold
 * `payload x in-flight`, or every allocation takes the standalone-SAB valve
 * and the run measures that instead. The orchestrator prints the overflow
 * count after each size so this cannot pass silently.
 */

const KIB = 1024;

const bun = (globalThis as unknown as {
  Bun?: {
    spawn(cmd: string[], o?: unknown): {
      stdout: ReadableStream;
      stderr: ReadableStream;
      exited: Promise<number>;
      kill(): void;
    };
    write(path: string, data: Uint8Array): Promise<number>;
    sleep(ms: number): Promise<void>;
  };
}).Bun;

if (bun === undefined) throw new Error("bench/http-body-oha.ts needs bun");

const env = (globalThis as unknown as {
  process: { env: Record<string, string | undefined>; exit(c: number): never };
}).process;

const DURATION = env.env.OHA_DURATION ?? "10s";
const CONNECTIONS = env.env.OHA_CONNECTIONS ?? "50";
const SIZES = (env.env.OHA_SIZES ?? "4096,65536,1048576")
  .split(",").map((v) => Number(v.trim()));

const ALL_ROUTES = [
  "/noop",
  "/arrayBuffer",
  "/bytes",
  "/arrayBufferRegion",
  "/bytesRegion",
  "/bunDrainRegion",
  "/streamRegion",
  "/commitRegion",
  "/policy",
];

/** Which server to drive; the pool server measures the full worker hop. */
const SERVER = env.env.OHA_SERVER ?? "bench/http-body-server.ts";

/** Which runtime runs the server. The orchestrator itself always needs bun. */
const RUNTIME = env.env.OHA_RUNTIME ?? "bun";
const RUNTIME_COMMAND: Record<string, string[]> = {
  bun: ["bun", "run"],
  deno: ["deno", "run", "-A", "--unstable-worker-options"],
  node: ["node", "--no-warnings", "--experimental-transform-types"],
};

const ROUTES = env.env.OHA_ROUTES === undefined
  ? ALL_ROUTES
  : env.env.OHA_ROUTES.split(",").map((r) => r.trim());

const text = async (stream: ReadableStream): Promise<string> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
};

// --- server ---------------------------------------------------------------
const launch = RUNTIME_COMMAND[RUNTIME];
if (launch === undefined) {
  throw new Error(`OHA_RUNTIME must be one of ${Object.keys(RUNTIME_COMMAND)}`);
}

const server = bun.spawn([...launch, SERVER], {
  env: { ...env.env, PORT: "0" },
  stdout: "pipe",
  stderr: "pipe",
});

let port = 0;
{
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value as Uint8Array, { stream: true });
  }
  reader.releaseLock();
  port = Number(buffered.match(/listening (\d+)/)?.[1] ?? 0);
}
if (port === 0) {
  console.error(await text(server.stderr));
  throw new Error("server did not report a port");
}

const base = `http://127.0.0.1:${port}`;
await bun.sleep(200);

// --- run ------------------------------------------------------------------
type Row = { rps: number; p50: number; p99: number; errors: number };

const runOha = async (
  url: string,
  bodyPath: string,
  chunked: boolean,
): Promise<Row> => {
  const args = [
    "oha",
    "-z", DURATION,
    "-c", CONNECTIONS,
    "-m", "POST",
    "-D", bodyPath,
    "--no-tui",
    "--output-format", "json",
    url,
  ];
  // oha sets Content-Length from the file; force chunked by overriding it.
  if (chunked) args.splice(args.length - 1, 0, "-H", "transfer-encoding: chunked");

  const proc = bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = await text(proc.stdout);
  await proc.exited;
  const parsed = JSON.parse(out) as {
    summary: { requestsPerSec: number; successRate?: number };
    latencyPercentiles: { p50: number; p99: number };
    errorDistribution?: Record<string, number>;
    statusCodeDistribution?: Record<string, number>;
  };
  const status = parsed.statusCodeDistribution ?? {};
  const nonOk = Object.entries(status)
    .filter(([code]) => code !== "200")
    .reduce((sum, [, n]) => sum + n, 0);
  // Requests still in flight when -z expires are reported as errors but are
  // not failures; everything else is.
  const errors = Object.entries(parsed.errorDistribution ?? {})
    .filter(([kind]) => !kind.includes("aborted due to deadline"))
    .reduce((sum, [, n]) => sum + n, 0) + nonOk;
  return {
    rps: parsed.summary.requestsPerSec,
    p50: parsed.latencyPercentiles.p50 * 1000,
    p99: parsed.latencyPercentiles.p99 * 1000,
    errors,
  };
};

const label = (size: number) =>
  size >= 1024 * KIB ? `${size / KIB / 1024} MiB` : `${size / KIB} KiB`;

console.log(
  `oha -z ${DURATION} -c ${CONNECTIONS}, ${RUNTIME} server, ` +
    `rps / p50 / p99 (ms)\n`,
);

for (const size of SIZES) {
  const bodyPath = `/tmp/knitting-oha-body-${size}.bin`;
  await bun.write(bodyPath, new Uint8Array(size).fill(9));

  console.log(`--- ${label(size)} ---`);
  for (const route of ROUTES) {
    // /commitRegion is the no-Content-Length path, so drive it chunked.
    const chunked = route === "/commitRegion";
    const row = await runOha(`${base}${route}`, bodyPath, chunked);
    const flag = row.errors > 0 ? `  !! ${row.errors} non-200/errors` : "";
    console.log(
      `  ${route.padEnd(20)} ${row.rps.toFixed(0).padStart(8)} rps   ` +
        `p50 ${row.p50.toFixed(2).padStart(7)}   ` +
        `p99 ${row.p99.toFixed(2).padStart(7)}${flag}`,
    );
  }

  const statsResponse = await fetch(`${base}/stats`);
  if (statsResponse.ok) {
    const stats = await statsResponse.json() as { overflows?: number };
    if ((stats.overflows ?? 0) > 0) {
      console.log(`  (allocator overflows: ${stats.overflows})`);
    }
  } else {
    await statsResponse.body?.cancel();
  }
  console.log();
}

server.kill();
