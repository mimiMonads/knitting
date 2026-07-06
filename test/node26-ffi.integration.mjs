import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";
import { createPool, isMain } from "../knitting.js";
import {
  getDefaultProcessSharedBufferPrimitives,
  ProcessSharedBuffer,
} from "../process-shared-buffer.js";
import { BufferReference } from "../unsafe.js";
import { mapNodeFfiSharedMemory } from "../src/connections/node-ffi.js";

export const incrementProcessSharedBuffer = (buffer) => {
  const view = buffer.view(Int32Array);
  return Atomics.add(view, 0, 1) + 1;
};

export const sumBufferReference = (reference) => {
  let sum = 0;
  for (const value of reference.toUint8Array()) sum += value;
  return sum;
};

export const reverseBufferReference = (reference) => {
  const input = reference.toUint8Array();
  return new BufferReference(Uint8Array.from(input).reverse());
};

export const spawnChildProcessProbe = () => {
  const result = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.stdout.trim();
};

export const processExecArgvProbe = () => process.execArgv;

if (isMain) {
  if (process.platform !== "win32") {
    const callerFd = openSync("/dev/null", "r");
    try {
      assert.throws(
        () =>
          mapNodeFfiSharedMemory({
            fd: callerFd,
            size: 64,
            duplicateFd: false,
          }),
        /mmap failed/,
      );
      assert.doesNotThrow(() => fstatSync(callerFd));
    } finally {
      closeSync(callerFd);
    }
  }

  const sharedName = `knit_n26_${process.pid}_${Date.now().toString(36)}`;
  const primitives = getDefaultProcessSharedBufferPrimitives();
  const shared = ProcessSharedBuffer.create({
    size: 64,
    mode: "create",
    name: sharedName,
  });
  const sharedView = shared.view(Int32Array);
  Atomics.store(sharedView, 0, 41);

  const processPool = createPool({
    threads: 1,
    worker: {
      runtime: "process",
      processRuntime: "node",
      timers: {
        spinMicroseconds: 0,
        parkMs: 5_000,
      },
    },
    permission: {
      mode: "strict",
      allowImport: true,
      net: true,
    },
  })({
    incrementProcessSharedBuffer,
    processExecArgvProbe,
    spawnChildProcessProbe,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = performance.now();
    assert.equal(
      await processPool.call.incrementProcessSharedBuffer(shared),
      42,
    );
    assert.equal(
      (await processPool.call.processExecArgvProbe()).includes("--allow-net"),
      true,
    );
    await assert.rejects(
      () => processPool.call.spawnChildProcessProbe(),
      /access.*restricted|permission|ERR_ACCESS_DENIED|child.?process/i,
    );
    assert.ok(
      performance.now() - started < 1_000,
      "parked Node 26 FFI process worker did not poll promptly",
    );
    assert.equal(Atomics.load(sharedView, 0), 42);
  } finally {
    await processPool.shutdown();
    shared.descriptor.mapping?.close?.();
    assert.equal(shared.descriptor.mapping?.buffer.byteLength, 0);
    assert.equal(sharedView.byteLength, 0);
    primitives.unlinkSharedMemory?.(sharedName);
  }

  const threadPool = createPool({ threads: 1 })({
    reverseBufferReference,
    sumBufferReference,
  });
  try {
    const source = new Uint8Array([4, 8, 15, 16, 23, 42]);
    using reference = new BufferReference(source);
    assert.equal(await threadPool.call.sumBufferReference(reference), 108);
    assert.equal(source.byteLength, 0);

    const reverseSource = new Uint8Array([1, 2, 3, 4]);
    using reverseInput = new BufferReference(reverseSource);
    using reversed = await threadPool.call.reverseBufferReference(reverseInput);
    assert.deepEqual([...reversed.toUint8Array()], [4, 3, 2, 1]);
  } finally {
    await threadPool.shutdown();
  }

  console.log("Node 26 FFI integration passed");
}
