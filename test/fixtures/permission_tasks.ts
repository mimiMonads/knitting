import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { Worker } from "node:worker_threads";
import { task } from "../../knitting.ts";

export const writeIntoNodeModules = task<void, string>({
  f: () => {
    const output = path.resolve(
      process.cwd(),
      "node_modules",
      ".knitting-permission-probe.tmp",
    );
    writeFileSync(output, "blocked");
    return output;
  },
});

export const writeIntoCwd = task<void, string>({
  f: () => {
    const output = path.resolve(
      process.cwd(),
      ".knitting-permission-allowed.tmp",
    );
    writeFileSync(output, "ok");
    return output;
  },
});

export const readGitDirectory = task<void, number>({
  f: () => {
    const gitDir = path.resolve(process.cwd(), ".git");
    return readdirSync(gitDir).length;
  },
});

export const readReadme = task<void, string>({
  f: () => {
    const readmePath = path.resolve(process.cwd(), "README.md");
    return readFileSync(readmePath, "utf8");
  },
});

export const spawnChildProcess = task<void, string>({
  f: () => {
    const out = spawnSync(process.execPath, ["--version"], {
      encoding: "utf8",
    });
    if (out.error) {
      throw out.error;
    }
    if (out.status !== 0) {
      throw new Error(out.stderr?.trim() || `spawn failed with code ${out.status}`);
    }
    return "spawn-ok";
  },
});

export const spawnViaWorkerThread = task<void, string>({
  f: async () => {
    const child = new Worker(
      `
        const { parentPort } = require("node:worker_threads");
        const { spawnSync } = require("node:child_process");
        try {
          const out = spawnSync("echo", ["worker-escape"], { encoding: "utf8" });
          if (out.error) throw out.error;
          if (out.status !== 0) throw new Error(out.stderr || "non-zero exit");
          parentPort.postMessage({ ok: true, out: out.stdout.trim() });
        } catch (error) {
          parentPort.postMessage({ ok: false, error: String(error) });
        }
      `,
      { eval: true },
    );

    try {
      const result = await new Promise<{ ok: boolean; out?: string; error?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("worker timeout")),
            3_000,
          );
          child.once("message", (message) => {
            clearTimeout(timer);
            resolve(message as { ok: boolean; out?: string; error?: string });
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(timer);
          });
        },
      );

      if (!result.ok) {
        throw new Error(result.error ?? "worker task failed");
      }
      return result.out ?? "";
    } finally {
      try {
        await child.terminate();
      } catch {
      }
    }
  },
});

export const spawnViaProcessBinding = task<void, string>({
  f: () => {
    const binding = (
      process as NodeJS.Process & {
        binding?: (name: string) => {
          spawn?: (options: unknown) => {
            status: number | null;
            output?: [unknown, Uint8Array | string | null, Uint8Array | string | null] | null;
          };
        };
      }
    ).binding?.("spawn_sync");

    if (!binding || typeof binding.spawn !== "function") {
      throw new Error("spawn_sync binding unavailable");
    }

    const out = binding.spawn({
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      args: ["echo", "binding-escape"],
      detached: false,
      envPairs: Object.entries(process.env).map(([k, v]) => `${k}=${v}`),
      file: "echo",
      windowsHide: false,
      windowsVerbatimArguments: false,
      stdio: [
        { type: "pipe", readable: true, writable: false },
        { type: "pipe", readable: false, writable: true },
        { type: "pipe", readable: false, writable: true },
      ],
    });

    if (out.status !== 0) {
      throw new Error(`spawn_sync status ${out.status}`);
    }

    const raw = out.output?.[1];
    const text = typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString("utf8")
        : "";
    return text.trim();
  },
});

export const readDeniedViaSymlink = task<void, string>({
  f: () => {
    const linkPath = path.resolve(process.cwd(), ".knitting-permission-link-probe");
    try {
      if (existsSync(linkPath)) unlinkSync(linkPath);
      symlinkSync("/etc/hosts", linkPath);
      return readFileSync(linkPath, "utf8");
    } finally {
      try {
        if (existsSync(linkPath)) unlinkSync(linkPath);
      } catch {
      }
    }
  },
});

export const tamperPerformanceNow = task<void, {
  sample: number;
  stableSample: number;
  changedToZero: boolean;
  replacedObject: boolean;
}>({
  f: () => {
    const stableNow = performance.now.bind(performance);
    let changedToZero = false;
    let replacedObject = false;
    try {
      (performance as unknown as { now: () => number }).now = () => 0;
      changedToZero = performance.now() === 0;
    } catch {
      changedToZero = false;
    }
    try {
      (globalThis as { performance: { now: () => number } }).performance = {
        now: () => 0,
      };
      replacedObject = performance.now() === 0;
    } catch {
      replacedObject = false;
    }
    return {
      sample: performance.now(),
      stableSample: stableNow(),
      changedToZero,
      replacedObject,
    };
  },
});
