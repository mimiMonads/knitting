// Fixture for `scripts/test-browser.ts`: tasks and library in one bundle, the
// shape a bundler produces for an app. The same bundle boots as the page and
// as every worker, which is why `setModuleUrl` is required.
import {
  createPool,
  isMain,
  setModuleUrl,
  task,
} from "../../knitting.browser.ts";

setModuleUrl(import.meta.url);

export const square = task({ f: (value: number) => value * value });

export const greet = task({ f: (name: string) => `hello ${name}` });

export const shape = task({
  f: (value: { a: number; b: string }) => ({
    sum: value.a + 1,
    tag: value.b.toUpperCase(),
  }),
});

export const bytes = task({
  f: (value: Uint8Array) => value.map((byte) => byte + 1),
});

export const spin = task({
  abortSignal: { hasAborted: true },
  f: (ms: number, signal) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (signal.hasAborted()) return -1;
    }
    return ms;
  },
});

if (isMain) {
  const results: Record<string, unknown> = {};
  const record = async (name: string, run: () => Promise<unknown>) => {
    try {
      results[name] = await run();
    } catch (error) {
      results[name] = "ERROR: " + String((error as Error)?.message ?? error);
    }
  };

  try {
    const pool = createPool({ threads: 4 })({
      square,
      greet,
      shape,
      bytes,
      spin,
    });

    await record("single", () => pool.call.square(7));
    await record("string", () => pool.call.greet("browser"));
    await record("object", () => pool.call.shape({ a: 1, b: "x" }));
    await record(
      "bytes",
      async () => Array.from(await pool.call.bytes(new Uint8Array([1, 2, 3]))),
    );
    await record("parallel", async () => {
      const values = await Promise.all(
        Array.from({ length: 200 }, (_, index) => pool.call.square(index)),
      );
      return values.reduce((total, value) => total + value, 0);
    });
    await record("abort", async () => {
      const running = pool.call.spin(3000);
      setTimeout(
        () => (running as unknown as { reject: () => void }).reject(),
        50,
      );
      return await running;
    });
    await record("shutdown", async () => {
      await pool.shutdown();
      return "ok";
    });
  } catch (error) {
    // A pool that cannot start at all, e.g. no cross-origin isolation.
    results.fatal = String((error as Error)?.message ?? error);
  }

  await fetch("/report", { method: "POST", body: JSON.stringify(results) });
}
