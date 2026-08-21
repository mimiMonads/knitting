import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { ProcessSharedBuffer } from "../shared-memory.ts";
import { readBootstrapState } from "./fixtures/bootstrap_tasks.ts";

const withTimeout = async <T>(
  promise: Promise<T>,
  ms = 5_000,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`test timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

test("worker bootstrap runs before task modules import", async () => {
  const pool = createPool({
    threads: 2,
    worker: {
      bootstrap: {
        href: "./fixtures/bootstrap_setup.ts",
        name: "setup",
        data: { value: "ready" },
      },
    },
  })({
    readBootstrapState,
  });

  try {
    const state = await withTimeout(pool.call.readBootstrapState());
    assert.deepEqual({
      importValue: state.importValue,
      runtimeValue: state.runtimeValue,
      sharedByteLength: state.sharedByteLength,
    }, {
      importValue: "ready",
      runtimeValue: "ready",
      sharedByteLength: null,
    });
    assert.equal(state.thread === 0 || state.thread === 1, true);
  } finally {
    await pool.shutdown();
  }
});

test("worker bootstrap receives ProcessSharedBuffer metadata as a value", async () => {
  const sab = new SharedArrayBuffer(128);
  const shared = ProcessSharedBuffer.fromMapping({
    runtime: "node",
    fd: 3,
    size: 128,
    byteLength: 128,
    buffer: sab,
    kind: "shared-array-buffer",
    sab,
  });
  const pool = createPool({
    threads: 1,
    worker: {
      bootstrap: {
        href: "./fixtures/bootstrap_setup.ts",
        name: "setup",
        data: {
          value: "shared",
          shared: shared.subbuffer(16, 32),
        },
      },
    },
  })({
    readBootstrapState,
  });

  try {
    assert.deepEqual(await withTimeout(pool.call.readBootstrapState()), {
      importValue: "shared",
      runtimeValue: "shared",
      sharedByteLength: 32,
      thread: 0,
    });
  } finally {
    await pool.shutdown();
  }
});

test("worker bootstrap failures reject pending calls", async () => {
  const pool = createPool({
    threads: 1,
    worker: {
      bootstrap: {
        href: "./fixtures/bootstrap_setup.ts",
        name: "fail",
      },
    },
  })({
    readBootstrapState,
  });

  try {
    await assert.rejects(
      withTimeout(pool.call.readBootstrapState()),
      /Worker startup failed: bootstrap failed/,
    );
  } finally {
    await pool.shutdown();
  }
});

test("worker bootstrap rejects inliner configuration", () => {
  assert.throws(
    () =>
      createPool({
        inliner: {},
        worker: {
          bootstrap: {
            href: "./fixtures/bootstrap_setup.ts",
            name: "setup",
          },
        },
      })({ readBootstrapState }),
    /worker\.bootstrap cannot be used with the inliner/,
  );
});
