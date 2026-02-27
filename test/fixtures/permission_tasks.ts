import path from "node:path";
import { spawnSync as spawnSyncLegacy } from "child_process";
import { spawnSync } from "node:child_process";
import { cp as cpPromise } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { connect as netConnect } from "node:net";
import {
  cpSync,
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { Worker } from "node:worker_threads";
import { task } from "../../knitting.ts";

const runNodeVersionProbe = (
  runner: typeof spawnSync,
  label: string,
): string => {
  const out = runner(process.execPath, ["--version"], {
    encoding: "utf8",
  });
  if (out.error) {
    throw out.error;
  }
  if (out.status !== 0) {
    throw new Error(out.stderr?.trim() || `spawn failed with code ${out.status}`);
  }
  return label;
};

const removeIfExists = (target: string): void => {
  try {
    if (existsSync(target)) unlinkSync(target);
  } catch {
  }
};

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
  f: () => runNodeVersionProbe(spawnSync, "spawn-ok"),
});

export const spawnChildProcessLegacySpecifier = task<void, string>({
  f: () => runNodeVersionProbe(spawnSyncLegacy, "spawn-legacy-ok"),
});

export const readEnvVar = task<string, string | undefined>({
  f: (name) => process.env[name],
});

export const fetchNetworkProbe = task<string, number>({
  f: async (url) => {
    const res = await fetch(url);
    return res.status;
  },
});

export const nodeHttpNetworkProbe = task<string, number>({
  f: (url) =>
    new Promise<number>((resolve, reject) => {
      const req = httpGet(url, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.setTimeout(500, () => {
        req.destroy(new Error("node:http timeout"));
      });
    }),
});

export const nodeNetNetworkProbe = task<{ host: string; port: number }, string>({
  f: ({ host, port }) =>
    new Promise<string>((resolve, reject) => {
      const socket = netConnect(port, host);
      socket.once("connect", () => {
        socket.end();
        resolve("connected");
      });
      socket.once("error", reject);
      socket.setTimeout(500, () => {
        socket.destroy(new Error("node:net timeout"));
      });
    }),
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
      removeIfExists(linkPath);
      symlinkSync("/etc/hosts", linkPath);
      return readFileSync(linkPath, "utf8");
    } finally {
      removeIfExists(linkPath);
    }
  },
});

export const readDeniedViaHardLink = task<void, string>({
  f: () => {
    const sourcePath = path.resolve(process.cwd(), ".git", "HEAD");
    const linkPath = path.resolve(process.cwd(), ".knitting-permission-hardlink-probe");
    try {
      removeIfExists(linkPath);
      linkSync(sourcePath, linkPath);
      return readFileSync(linkPath, "utf8");
    } finally {
      removeIfExists(linkPath);
    }
  },
});

export const copyDeniedViaCpSync = task<void, string>({
  f: () => {
    const sourcePath = path.resolve(process.cwd(), ".git", "HEAD");
    const outputPath = path.resolve(process.cwd(), ".knitting-permission-cp-sync-probe");
    try {
      removeIfExists(outputPath);
      cpSync(sourcePath, outputPath);
      return readFileSync(outputPath, "utf8");
    } finally {
      removeIfExists(outputPath);
    }
  },
});

export const copyDeniedViaCpPromise = task<void, string>({
  f: async () => {
    const sourcePath = path.resolve(process.cwd(), ".git", "HEAD");
    const outputPath = path.resolve(process.cwd(), ".knitting-permission-cp-promise-probe");
    try {
      removeIfExists(outputPath);
      await cpPromise(sourcePath, outputPath);
      return readFileSync(outputPath, "utf8");
    } finally {
      removeIfExists(outputPath);
    }
  },
});

export const readDeniedViaPreexistingSymlinkTraversal = task<void, string>({
  f: () => {
    const traversedPath = path.resolve(
      process.cwd(),
      ".knitting-permission-etc-traversal-link",
      "hosts",
    );
    return readFileSync(traversedPath, "utf8");
  },
});

export const probeDeniedExistsSync = task<void, boolean>({
  f: () => {
    const gitConfig = path.resolve(process.cwd(), ".git", "config");
    return existsSync(gitConfig);
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
