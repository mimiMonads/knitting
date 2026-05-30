import { createPool, isMain, task } from "../knitting.ts";

type HostRuntime = "bun" | "deno" | "node";
type ProcessRuntime = HostRuntime;
type PermissionMode = "strict" | "unsafe";

type WorkerOptions = {
  runtime?: "thread" | "process";
  processRuntime?: ProcessRuntime;
  processSharedMemory?: "inherit" | "named" | {
    mode?: "inherit" | "named";
    namePrefix?: string;
    unlinkOnShutdown?: boolean;
  };
};

type Candidate = {
  name: string;
  worker: WorkerOptions;
  command?: ProcessRuntime;
};

type Stats = {
  iterations: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p75Ms: number;
  p99Ms: number;
};

type Result = {
  name: string;
  hostRuntime: HostRuntime;
  workerRuntime: "thread" | "process";
  processRuntime?: ProcessRuntime;
  samplesMs: number[];
  stats: Stats;
};

type Skipped = {
  name: string;
  reason: string;
};

type SpawnSync = (
  command: string,
  args?: readonly string[],
  options?: {
    cwd?: string;
    stdio?: "ignore";
    timeout?: number;
  },
) => {
  status: number | null;
  error?: Error;
};

const DEFAULT_ITERATIONS = 12;
const DEFAULT_WARMUPS = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 2_000;

let spawnSyncFn: SpawnSync | undefined;

export const reply = task<string, string>({
  f: (message) => message === "ping" ? "pong" : message,
});

const globals = globalThis as typeof globalThis & {
  Bun?: unknown;
  Deno?: {
    args?: string[];
    cwd?: () => string;
    exit?: (code?: number) => never;
  };
  process?: {
    argv?: string[];
    cwd?: () => string;
    exit?: (code?: number) => never;
  };
};

const hostRuntime = (): HostRuntime => {
  if (globals.Bun !== undefined) return "bun";
  if (globals.Deno !== undefined) return "deno";
  return "node";
};

const argv = (): string[] => {
  if (Array.isArray(globals.Deno?.args)) return globals.Deno.args;
  if (Array.isArray(globals.process?.argv)) {
    return globals.process.argv.slice(2);
  }
  return [];
};

const cwd = (): string => {
  if (typeof globals.process?.cwd === "function") return globals.process.cwd();
  if (typeof globals.Deno?.cwd === "function") return globals.Deno.cwd();
  return ".";
};

const exit = (code: number): never => {
  if (typeof globals.Deno?.exit === "function") return globals.Deno.exit(code);
  if (typeof globals.process?.exit === "function") {
    return globals.process.exit(code);
  }
  throw new Error(`Cannot exit with code ${code}`);
};

const getSpawnSync = async (): Promise<SpawnSync> => {
  if (spawnSyncFn !== undefined) return spawnSyncFn;
  const mod = await import("node:child_process");
  spawnSyncFn = mod.spawnSync as unknown as SpawnSync;
  return spawnSyncFn;
};

const hasCommand = async (command: ProcessRuntime): Promise<boolean> => {
  try {
    const spawnSync = await getSpawnSync();
    const result = spawnSync(command, ["--version"], {
      cwd: cwd(),
      stdio: "ignore",
      timeout: COMMAND_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
};

const readIntegerFlag = (
  args: string[],
  name: string,
  fallback: number,
): number => {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found === undefined) return fallback;

  const value = Number(found.slice(prefix.length));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
};

const includesFlag = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const withTimeout = async <T>(
  label: string,
  promise: Promise<T>,
  ms: number,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const startupRoundTrip = async (
  candidate: Candidate,
  timeoutMs: number,
  permissionMode: PermissionMode,
): Promise<number> => {
  const started = performance.now();
  const pool = createPool({
    threads: 1,
    worker: candidate.worker,
    permission: permissionMode === "unsafe" ? "unsafe" : {
      mode: "strict",
      allowImport: true,
    },
    payload: {
      payloadMaxByteLength: 1024 * 1024,
    },
  })({ reply });

  let pendingError: unknown;
  try {
    const value = await withTimeout(
      `${candidate.name} first reply`,
      pool.call.reply("ping"),
      timeoutMs,
    );

    if (value !== "pong") {
      throw new Error(`${candidate.name} returned ${String(value)}`);
    }

    return performance.now() - started;
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      await withTimeout(
        `${candidate.name} shutdown`,
        pool.shutdown(),
        timeoutMs,
      );
    } catch (shutdownError) {
      if (pendingError !== undefined) {
        throw new AggregateError(
          [pendingError, shutdownError],
          `${errorMessage(pendingError)}; ${errorMessage(shutdownError)}`,
        );
      }
      throw shutdownError;
    }
  }
};

const percentile = (sorted: number[], ratio: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index]!;
};

const statsFor = (samples: number[]): Stats => {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    iterations: samples.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    avgMs: samples.length === 0 ? 0 : total / samples.length,
    p50Ms: percentile(sorted, 0.50),
    p75Ms: percentile(sorted, 0.75),
    p99Ms: percentile(sorted, 0.99),
  };
};

const processRuntimeCandidates = (
  currentRuntime: HostRuntime,
  allProcessRuntimes: boolean,
): ProcessRuntime[] =>
  allProcessRuntimes ? ["bun", "deno", "node"] : [currentRuntime];

const buildCandidates = (
  currentRuntime: HostRuntime,
  allProcessRuntimes: boolean,
  includeNamedProcessSharedMemory: boolean,
): Candidate[] => {
  const candidates: Candidate[] = [{
    name: "thread",
    worker: {
      runtime: "thread",
    },
  }];

  for (
    const processRuntime of processRuntimeCandidates(
      currentRuntime,
      allProcessRuntimes,
    )
  ) {
    candidates.push({
      name: `process:${processRuntime}`,
      worker: {
        runtime: "process",
        processRuntime,
      },
      command: processRuntime,
    });

    if (includeNamedProcessSharedMemory) {
      candidates.push({
        name: `process:${processRuntime}:named-shm`,
        worker: {
          runtime: "process",
          processRuntime,
          processSharedMemory: {
            mode: "named",
            namePrefix: `knit_startup_${processRuntime}`,
          },
        },
        command: processRuntime,
      });
    }
  }

  return candidates;
};

const measureCandidate = async (
  candidate: Candidate,
  iterations: number,
  warmups: number,
  timeoutMs: number,
  permissionMode: PermissionMode,
): Promise<Result | Skipped> => {
  if (candidate.command !== undefined && !await hasCommand(candidate.command)) {
    return {
      name: candidate.name,
      reason: `${candidate.command} command was not found`,
    };
  }

  try {
    await startupRoundTrip(candidate, timeoutMs, permissionMode);
  } catch (error) {
    return {
      name: candidate.name,
      reason: errorMessage(error),
    };
  }

  for (let i = 1; i < warmups; i++) {
    await startupRoundTrip(candidate, timeoutMs, permissionMode);
  }

  const samplesMs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    samplesMs.push(
      await startupRoundTrip(candidate, timeoutMs, permissionMode),
    );
  }

  const workerRuntime = candidate.worker.runtime ?? "thread";
  return {
    name: candidate.name,
    hostRuntime: hostRuntime(),
    workerRuntime,
    processRuntime: candidate.worker.processRuntime,
    samplesMs,
    stats: statsFor(samplesMs),
  };
};

const time = (ms: number): string => {
  if (ms < 1) return `${(ms * 1000).toFixed(2)}us`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const printMarkdown = (
  runtime: HostRuntime,
  iterations: number,
  warmups: number,
  timeoutMs: number,
  permissionMode: PermissionMode,
  results: Result[],
  skipped: Skipped[],
) => {
  console.log(`startup round-trip (host: ${runtime})`);
  console.log(
    `measured: createPool -> first reply("ping") response; shutdown is excluded`,
  );
  console.log(
    `iterations: ${iterations}, warmups: ${warmups}, timeout: ${timeoutMs}ms, permission: ${permissionMode}`,
  );
  console.log("");
  console.log("| worker | avg | min | p50 | p75 | p99 | max |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");

  for (const result of results) {
    const { stats } = result;
    console.log(
      `| ${result.name} | ${time(stats.avgMs)} | ${time(stats.minMs)} | ` +
        `${time(stats.p50Ms)} | ${time(stats.p75Ms)} | ` +
        `${time(stats.p99Ms)} | ${time(stats.maxMs)} |`,
    );
  }

  if (skipped.length > 0) {
    console.log("");
    console.log("skipped:");
    for (const skip of skipped) {
      console.log(`- ${skip.name}: ${skip.reason}`);
    }
  }
};

const printUsage = () => {
  console.log(
    "Usage: bench/startup.ts [--json] [--iterations=N] [--warmups=N]",
  );
  console.log(
    "                        [--timeout-ms=N] [--all-process-runtimes]",
  );
  console.log("                        [--strict-permission] [--named-process-shm]");
  console.log("");
  console.log(
    "By default it compares thread vs process using the current runtime.",
  );
  console.log("By default it uses unsafe permissions to isolate startup cost.");
  console.log(
    "--all-process-runtimes also tries process:bun, process:deno, and process:node.",
  );
  console.log(
    "--named-process-shm also measures process workers using named shared memory.",
  );
};

const main = async () => {
  const args = argv();
  if (includesFlag(args, "help")) {
    printUsage();
    return;
  }

  const runtime = hostRuntime();
  const iterations = Math.max(
    1,
    readIntegerFlag(args, "iterations", DEFAULT_ITERATIONS),
  );
  const warmups = Math.max(
    1,
    readIntegerFlag(args, "warmups", DEFAULT_WARMUPS),
  );
  const timeoutMs = readIntegerFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS);
  const allProcessRuntimes = includesFlag(args, "all-process-runtimes");
  const includeNamedProcessSharedMemory = includesFlag(
    args,
    "named-process-shm",
  );
  const permissionMode: PermissionMode = includesFlag(args, "strict-permission")
    ? "strict"
    : "unsafe";
  const json = includesFlag(args, "json");
  const candidates = buildCandidates(
    runtime,
    allProcessRuntimes,
    includeNamedProcessSharedMemory,
  );
  const results: Result[] = [];
  const skipped: Skipped[] = [];

  for (const candidate of candidates) {
    const result = await measureCandidate(
      candidate,
      iterations,
      warmups,
      timeoutMs,
      permissionMode,
    );
    if ("reason" in result) {
      skipped.push(result);
    } else {
      results.push(result);
    }
  }

  if (results.length === 0) {
    skipped.push({
      name: "startup",
      reason: "no startup candidates could run",
    });
  }

  if (json) {
    console.log(JSON.stringify(
      {
        context: {
          hostRuntime: runtime,
          iterations,
          warmups,
          timeoutMs,
          permissionMode,
          allProcessRuntimes,
          includeNamedProcessSharedMemory,
        },
        benchmarks: results,
        skipped,
      },
      null,
      2,
    ));
    return;
  }

  printMarkdown(
    runtime,
    iterations,
    warmups,
    timeoutMs,
    permissionMode,
    results,
    skipped,
  );

  if (results.length === 0) exit(1);
};

if (isMain) {
  await main();
}
