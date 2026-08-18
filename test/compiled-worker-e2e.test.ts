import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "../src/connections/process-shared-buffer.ts";
import { spawnCompiledWorkerContext } from "../src/runtime/compiled-worker.ts";
import test from "./_runner.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const builder = join(here, "..", "scripts", "build-compiled-worker.ts");

const speaksPorffor = (candidate: string): boolean => {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return probe.status === 0 && (probe.stdout ?? "").startsWith("alpha ");
};

/**
 * Only an already-installed compiler counts. Resolving the way the build script
 * does would let a test clone Porffor from the network, so an absent compiler
 * skips instead.
 */
const findPorffor = (): string | undefined => {
  const cache = join(homedir(), ".cache", "knitting");
  const cached = existsSync(cache)
    ? readdirSync(cache)
      .filter((entry) => entry.startsWith("porffor-"))
      .map((entry) => join(cache, entry, "porf"))
    : [];
  for (const candidate of [process.env.PORF, process.env.PORFFOR_MAIN, "porf"]) {
    if (candidate !== undefined && speaksPorffor(candidate)) return candidate;
  }
  return cached.find(speaksPorffor);
};

const porffor = findPorffor();
const skip = porffor === undefined
  ? "skipping compiled worker end-to-end tests: Porffor is not installed"
  : false;

let outputDirectory: string | undefined;

const compile = (fixture: string, tasks: string[]): string => {
  outputDirectory ??= mkdtempSync(join(tmpdir(), "knitting-compiled-"));
  const artifact = join(outputDirectory, fixture + ".knt");
  if (existsSync(artifact)) return artifact;
  const build = spawnSync("bun", [
    builder,
    "--module",
    join(here, "fixtures", fixture + ".ts"),
    "--out",
    artifact,
    "--tasks",
    tasks.join(","),
    "--porf",
    porffor!,
  ], { encoding: "utf8" });
  assert.equal(build.status, 0, "Porffor build failed: " + build.stderr);
  return artifact;
};

const openWorker = (fixture: string, names: string[], usesAbortSignal = false) => {
  const context = spawnCompiledWorkerContext({
    list: [join(here, "fixtures", fixture + ".ts")],
    names,
    workerOptions: {
      compiled: { build: false, artifact: compile(fixture, names) },
    } as never,
    usesAbortSignal,
    abortSignalCapacity: 4,
  });
  const call = (task: string, value: unknown) =>
    (context.call({
      fnNumber: names.indexOf(task),
      abortSignal: usesAbortSignal ? {} : undefined,
    } as never) as never as (
      input: unknown,
    ) => Promise<unknown> & { reject: (reason?: unknown) => void })(
      value as never,
    );
  return { context, call };
};

const uniqueShmName = (): string =>
  `knit_e2e_${process.pid.toString(36)}_${
    Math.random().toString(36).slice(2, 8)
  }`;

test("compiled workers round-trip binary values and shared buffers", {
  skip,
}, async () => {
  const names = [
    "incrementBytes",
    "incrementArrayBuffer",
    "incrementWords",
    "readDataView",
    "readSharedBytes",
    "sharedByteLength",
    "readClock",
  ];
  const { context, call } = openWorker("compiled_special_tasks", names);
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const name = uniqueShmName();
  const shared = ProcessSharedBuffer.create(
    { mode: "create", name, size: 64 },
    primitives,
  );

  try {
    assert.deepEqual(
      await call("incrementBytes", new Uint8Array([1, 2, 3])),
      new Uint8Array([2, 3, 4]),
    );
    assert.deepEqual(
      new Uint8Array(
        await call(
          "incrementArrayBuffer",
          new Uint8Array([9, 10]).buffer,
        ) as ArrayBuffer,
      ),
      new Uint8Array([10, 11]),
    );
    assert.deepEqual(
      await call("incrementWords", new Int32Array([1, -2, 3])),
      new Int32Array([2, -1, 4]),
    );
    assert.equal(
      await call(
        "readDataView",
        new DataView(new Uint8Array([0x34, 0x12]).buffer),
      ),
      0x1234,
    );

    // Base64 keeps this inside the frame budget; a decimal byte array could
    // not carry a payload anywhere near this size.
    const large = new Uint8Array(300 * 1024).map((_, index) => index & 0xff);
    const echoed = await call("incrementBytes", large) as Uint8Array;
    assert.equal(echoed.length, large.length);
    assert.equal(echoed[0], 1);
    assert.equal(echoed[large.length - 1], (large[large.length - 1]! + 1) & 0xff);

    shared.bytes().set([7, 11, 0, 0, 3, 5]);
    assert.equal(await call("readSharedBytes", shared.subbuffer(0, 2)), 18);
    assert.equal(await call("sharedByteLength", shared.subbuffer(4, 2)), 2);
    // A non-zero byteOffset must not silently read from the start of the map.
    assert.equal(await call("readSharedBytes", shared.subbuffer(4, 2)), 8);
    // The second call reuses the cached mapping rather than remapping.
    assert.equal(await call("readSharedBytes", shared.subbuffer(4, 2)), 8);

    await assert.rejects(
      () => call("readDataView", { $knitting: "u8", data: "AAA=" }),
      /reserve the \$knitting key/,
    );
  } finally {
    shared.descriptor.mapping?.close?.();
    primitives.unlinkSharedMemory?.(name);
    await context.kills!();
  }
});

test("compiled workers observe aborts and shut down gracefully", {
  skip,
}, async () => {
  const { context, call } = openWorker(
    "compiled_abort_tasks",
    ["abortSpin"],
    true,
  );

  try {
    const running = call("abortSpin", 42);
    const timer = setTimeout(() => running.reject(), 50);
    // abortSpin returns its input only when it saw the abort bit flip.
    assert.equal(await running, 42);
    clearTimeout(timer);

    // A task left alone spins to completion and reports that it never aborted.
    assert.equal(await call("abortSpin", 7), -1);
  } finally {
    await context.kills!();
  }
});

test("compiled worker end-to-end fixtures clean up", { skip }, () => {
  if (outputDirectory !== undefined) {
    rmSync(outputDirectory, { recursive: true, force: true });
    outputDirectory = undefined;
  }
  assert.equal(outputDirectory, undefined);
});
