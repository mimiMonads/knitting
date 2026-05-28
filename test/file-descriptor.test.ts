import assert from "node:assert/strict";
import type { Buffer as NodeBuffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "./_runner.ts";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  FileDescriptor,
  parseFileDescriptorMetadata,
  type SharedMemoryMapping,
} from "../src/connections/index.ts";
import { createNodeConnectionPrimitives } from "../src/connections/node.ts";
import {
  F_GETFD,
  F_SETFD,
  FD_CLOEXEC,
  setCloseOnExec,
} from "../src/connections/posix.ts";

const futexChildPath = fileURLToPath(
  new URL(
    "./fixtures/probes/file_descriptor_futex_child.ts",
    import.meta.url,
  ),
);
const require = createRequire(import.meta.url);

const versions = (globalThis as typeof globalThis & {
  process?: { versions?: { bun?: string; node?: string } };
}).process?.versions;
const isPlainNode = typeof versions?.node === "string" &&
  versions.bun === undefined &&
  (globalThis as typeof globalThis & { Deno?: unknown }).Deno === undefined;
const nodeProcess = isPlainNode
  ? (globalThis as typeof globalThis & { process: NodeJS.Process }).process
  : undefined;
const nativeFdTestsAreEnabled = nodeProcess?.platform === "linux" ||
  nodeProcess?.env.KNITTING_EXPERIMENTAL_NATIVE_FD_TESTS === "1";
const nativeAddonPaths = (name: string): readonly string[] => {
  const platform = nodeProcess?.platform;
  const arch = nodeProcess?.arch;
  const modules = nodeProcess?.versions.modules;
  const prebuildDir = platform !== undefined && arch !== undefined &&
      modules !== undefined
    ? `${platform}-${arch}-node-${modules}`
    : undefined;
  const candidates = prebuildDir !== undefined
    ? [
      new URL(`../prebuilds/${prebuildDir}/${name}.node`, import.meta.url),
      new URL(`../build/Release/${name}.node`, import.meta.url),
    ]
    : [new URL(`../build/Release/${name}.node`, import.meta.url)];
  return candidates.map((url) => fileURLToPath(url));
};

type SharedMemoryAddon = {
  createSharedMemory: (size: number) => {
    sab: SharedArrayBuffer;
    fd: number;
    size: number;
    baseAddressMod64?: number;
  };
  mapSharedMemory: (fd: number, size: number) => {
    sab: SharedArrayBuffer;
    fd: number;
    size: number;
    baseAddressMod64?: number;
  };
};

type FutexAddon = {
  sleep: (milliseconds?: number) => void;
  yield: () => void;
  wakeU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    count?: number,
  ) => number;
  waitU32: (
    buffer: ArrayBuffer | SharedArrayBuffer,
    byteOffset: number,
    expected: number,
    timeoutMs?: number,
  ) => "woken" | "changed" | "interrupted" | "timed-out";
};

type NativeAddonProbe<T> = {
  addon?: T;
  path?: string;
  skipReason?: string;
};

const nativeFdGateReason = (): string | undefined => {
  if (!isPlainNode) return "requires plain Node";

  if (!nativeFdTestsAreEnabled) {
    return `disabled on ${
      nodeProcess?.platform ?? "unknown"
    }; set KNITTING_EXPERIMENTAL_NATIVE_FD_TESTS=1 to opt in`;
  }

  return undefined;
};

const nativeCrossProcessFdGateReason = (): string | undefined => {
  const baseReason = nativeFdGateReason();
  if (baseReason !== undefined) return baseReason;
  if (nodeProcess?.platform === "win32") {
    return "cross-process fd inheritance is POSIX-only";
  }
  return undefined;
};

const probeNativeAddon = <T>(
  paths: readonly string[],
  label: string,
  gateReason = nativeFdGateReason(),
): NativeAddonProbe<T> => {
  if (gateReason !== undefined) return { skipReason: gateReason };

  const path = paths.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    return { skipReason: `${label} addon is not prebuilt or built` };
  }

  try {
    return { addon: require(path) as T, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipReason: `${label} addon could not load: ${message}` };
  }
};

const nativeTestName = (name: string, probe: NativeAddonProbe<unknown>) =>
  probe.skipReason === undefined
    ? name
    : `${name} [native fd skipped: ${probe.skipReason}]`;

const sharedMemoryAddonProbe = probeNativeAddon<SharedMemoryAddon>(
  nativeAddonPaths("knitting_shared_memory"),
  "shared memory",
);
const futexAddonProbe = probeNativeAddon<FutexAddon>(
  nativeAddonPaths("knitting_shm"),
  "futex",
);
const crossProcessFutexAddonProbe = probeNativeAddon<FutexAddon>(
  nativeAddonPaths("knitting_shm"),
  "futex",
  nativeCrossProcessFdGateReason(),
);

const nativeSharedMemoryTest = sharedMemoryAddonProbe.addon === undefined
  ? test.skip
  : test;
const nativeFutexTest = sharedMemoryAddonProbe.addon === undefined ||
    futexAddonProbe.addon === undefined
  ? test.skip
  : test;
const nativeCrossProcessFutexTest =
  sharedMemoryAddonProbe.addon === undefined ||
    crossProcessFutexAddonProbe.addon === undefined
    ? test.skip
    : test;

nativeFutexTest(
  nativeTestName(
    "futex addon exposes sleep and yield helpers",
    futexAddonProbe,
  ),
  () => {
    const futex = futexAddonProbe.addon;
    assert.ok(futex !== undefined);

    futex.yield();
    futex.sleep(0);
    futex.sleep(1);
  },
);

test("close-on-exec helper programs shared-memory descriptors", () => {
  const calls: Array<[number, number, number]> = [];
  const libc = {
    symbols: {
      fcntl: (fd: number, cmd: number, arg: number) => {
        calls.push([fd, cmd, arg]);
        if (cmd === F_GETFD) return 0x20;
        if (cmd === F_SETFD) return 0;
        return -1;
      },
    },
  };

  assert.equal(setCloseOnExec(libc, 7), 7);
  assert.deepEqual(calls, [
    [7, F_GETFD, 0],
    [7, F_SETFD, 0x20 | FD_CLOEXEC],
  ]);
});

test("FileDescriptor stringifies and restores descriptor metadata", () => {
  const sab = new SharedArrayBuffer(64);
  const mapping: SharedMemoryMapping<SharedArrayBuffer> = {
    runtime: "node",
    fd: 3,
    size: 64,
    byteLength: 64,
    buffer: sab,
    kind: "shared-array-buffer",
    sab,
    baseAddressMod64: 0,
  };

  const descriptor = FileDescriptor.fromMapping(mapping);
  const serialized = descriptor.stringifyMetadata();

  assert.deepEqual(parseFileDescriptorMetadata(serialized), {
    version: 1,
    fd: 3,
    size: 64,
    byteLength: 64,
    runtime: "node",
    kind: "shared-array-buffer",
    baseAddressMod64: 0,
  });

  const restored = FileDescriptor.fromMetadata(serialized);
  assert.equal(restored.fd, 3);
  assert.equal(restored.size, 64);
  assert.equal(restored.byteLength, 64);
  assert.equal(restored.runtime, "node");
  assert.equal(restored.kind, "shared-array-buffer");
  assert.throws(
    () => restored.getSAB(),
    /not attached to a SharedArrayBuffer mapping/,
  );

  assert.equal(descriptor.getSAB(), sab);
});

test("FileDescriptor preserves named mapping metadata", () => {
  const sab = new SharedArrayBuffer(64);
  const mapping: SharedMemoryMapping<SharedArrayBuffer> = {
    runtime: "node",
    fd: 11,
    name: "Local\\knitting-test-channel",
    size: 64,
    byteLength: 64,
    buffer: sab,
    kind: "shared-array-buffer",
    sab,
    baseAddressMod64: 0,
  };

  const descriptor = FileDescriptor.fromMapping(mapping);
  assert.deepEqual(descriptor.toMetadata(), {
    version: 1,
    fd: 11,
    name: "Local\\knitting-test-channel",
    size: 64,
    byteLength: 64,
    runtime: "node",
    kind: "shared-array-buffer",
    baseAddressMod64: 0,
  });

  const restored = FileDescriptor.parse(descriptor.stringifyMetadata());
  assert.equal(restored.name, "Local\\knitting-test-channel");

  let mappedName: string | undefined;
  restored.map({
    mapSharedMemory: (options) => {
      mappedName = options.name;
      return mapping;
    },
  });
  assert.equal(mappedName, "Local\\knitting-test-channel");
});

nativeSharedMemoryTest(
  nativeTestName(
    "FileDescriptor maps serialized metadata back into a Node SharedArrayBuffer",
    sharedMemoryAddonProbe,
  ),
  () => {
    const addon = sharedMemoryAddonProbe.addon;
    assert.ok(addon !== undefined);

    const primitives = createNodeConnectionPrimitives(addon);
    const original = FileDescriptor.fromMapping(
      primitives.createSharedMemory(128),
    );
    const restored = FileDescriptor.parse(original.stringifyMetadata());

    const originalSab = original.getSAB();
    const restoredSab = restored.getSAB(primitives);

    assert.notEqual(restoredSab, originalSab);

    const originalCells = new Int32Array(originalSab);
    const restoredCells = new Int32Array(restoredSab);

    Atomics.store(originalCells, 0, 41);
    assert.equal(Atomics.load(restoredCells, 0), 41);

    Atomics.store(restoredCells, 1, 42);
    assert.equal(Atomics.load(originalCells, 1), 42);
  },
);

nativeSharedMemoryTest(
  nativeTestName(
    "shared memory fds are marked close-on-exec",
    sharedMemoryAddonProbe,
  ),
  () => {
    if (nodeProcess?.platform !== "linux") {
      return;
    }

    const addon = sharedMemoryAddonProbe.addon;
    assert.ok(addon !== undefined);

    const primitives = createNodeConnectionPrimitives(addon);
    const mapping = primitives.createSharedMemory(64);
    const fdinfo = readFileSync(`/proc/self/fdinfo/${mapping.fd}`, "utf8");
    const match = fdinfo.match(/^flags:\s+([0-7]+)/m);
    assert.ok(match !== null, fdinfo);

    const flags = Number.parseInt(match[1]!, 8);
    assert.equal((flags & 0o2000000) !== 0, true, fdinfo);
  },
);

nativeCrossProcessFutexTest(
  nativeTestName(
    "FileDescriptor metadata can be remapped and woken with native futex",
    sharedMemoryAddonProbe.addon === undefined
      ? sharedMemoryAddonProbe
      : crossProcessFutexAddonProbe,
  ),
  async () => {
    const addon = sharedMemoryAddonProbe.addon;
    const futex = crossProcessFutexAddonProbe.addon;
    assert.ok(addon !== undefined);
    assert.ok(futex !== undefined);

    const primitives = createNodeConnectionPrimitives(addon);
    const mapping = primitives.createSharedMemory(128);
    const sab = mapping.sab;
    if (sab === undefined) {
      throw new Error("Node shared memory mapping did not return a SAB");
    }
    const cells = new Int32Array(sab);
    const metadata = FileDescriptor.fromMapping(mapping).toMetadata();
    const childMetadata = JSON.stringify({
      ...metadata,
      fd: 3,
    });

    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        futexChildPath,
        childMetadata,
        crossProcessFutexAddonProbe.path!,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe", mapping.fd],
      },
    );

    let stdout = "";
    let stderr = "";
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      throw new Error("child stdio pipes were not created");
    }

    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: NodeBuffer | string) => {
      stdout += chunk.toString();
    });
    childStderr.on("data", (chunk: NodeBuffer | string) => {
      stderr += chunk.toString();
    });

    const deadline = Date.now() + 5000;
    while (!stdout.includes("ready\n") && Date.now() < deadline) {
      await delay(5);
    }
    assert.match(stdout, /ready\n/);
    assert.equal(Atomics.load(cells, 0), 1);

    let wakeCount = 0;
    while (wakeCount === 0 && Date.now() < deadline) {
      wakeCount = futex.wakeU32(sab, 4, 1);
      if (wakeCount === 0) await delay(5);
    }

    assert.equal(wakeCount, 1);

    const parentWait = futex.waitU32(sab, 8, 0, 5000);
    assert.match(parentWait, /^(woken|changed)$/);

    const exit = await new Promise<
      { code: number | null; signal: string | null }
    >(
      (resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0, stderr || stdout);
    assert.equal(Atomics.load(cells, 2), 42);

    const parsed = JSON.parse(stdout.trim().split(/\n/).at(-1) ?? "{}");
    assert.equal(parsed.waitResult, "woken");
    assert.equal(parsed.value, 42);
    assert.equal(typeof parsed.parentWakeCount, "number");
  },
);
