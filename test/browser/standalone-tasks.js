// Fixture for `scripts/test-browser.ts`: plain JavaScript from a script tag,
// against the emitted single-file bundle. The tasks live in their own module
// here, so `setModuleUrl` is what lets a worker find them.
import { createPool, isMain, setModuleUrl, task } from "/knitting.browser.js";

setModuleUrl(import.meta.url);

export const square = task({ f: (value) => value * value });

export const greet = task({ f: (name) => `hello ${name}` });

if (isMain) {
  const results = {};
  try {
    const pool = createPool({ threads: 2 })({ square, greet });
    results.single = await pool.call.square(7);
    results.string = await pool.call.greet("browser");
    const values = await Promise.all(
      Array.from({ length: 50 }, (_, index) => pool.call.square(index)),
    );
    results.parallel = values.reduce((total, value) => total + value, 0);
    await pool.shutdown();
    results.shutdown = "ok";
  } catch (error) {
    results.fatal = String(error?.message ?? error);
  }
  await fetch("/report", { method: "POST", body: JSON.stringify(results) });
}
