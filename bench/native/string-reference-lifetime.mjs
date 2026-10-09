import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { nativeStrings as native } from "./string-reference.mjs";
import process from "node:process";

const collect = globalThis.Bun ? () => Bun.gc(true) : globalThis.gc;
const isExternal = native.isExternal ?? (() => true);

// Run with --expose-gc. Full code-unit equality includes unpaired surrogates,
// which UTF-8 encoding would replace, and one-/two-byte external resources.
function checkContent() {
  for (const pattern of ["a", "éÿ", "編🧶", "\ud800x\udfff", "a\0b"]) {
    const source = pattern.repeat(4096);
    const token = native.retain(source);
    const adopted = native.adopt(token);
    const secondConsumer = native.adopt(token);
    assert.equal(isExternal(adopted), true);
    assert.equal(isExternal(secondConsumer), true);
    assert.equal(native.copy(token), source);
    assert.equal(native.release(token), true);
    assert.equal(native.release(token), false);
    assert.throws(() => native.adopt(token), /Released/);
    assert.equal(adopted, source);
    assert.equal(secondConsumer, source);
    assert.equal(adopted.slice(10, 100), source.slice(10, 100));
  }
}
checkContent();
assert.throws(() => native.retain(""), /nonempty/);
assert.throws(() => native.adopt(-1n), /Invalid/);
assert.throws(() => native.release("1"), /bigint/);

async function checkWorkers() {
  const addonUrl = new URL("./string-reference.mjs", import.meta.url).href;
  const makeWorker = (body) =>
    new Worker(
      `
  const { parentPort } = require('node:worker_threads');
  import(${
        JSON.stringify(addonUrl)
      }).then(({ nativeStrings: native }) => { ${body} });
`,
      { eval: true },
    );

  // Consumer keeps an external string after sender release, then GC reclaims it
  // on consumer teardown. No finalizer in JS is needed to keep it alive.
  const consumer = makeWorker(`
  let held;
  parentPort.on('message', ({ op, token }) => {
    if (op === 'adopt') {
      held = native.adopt(token);
      parentPort.postMessage(native.isExternal ? native.isExternal(held) : true);
    } else if (op === 'drop') {
      held = undefined;
      globalThis.Bun?.gc(true);
      parentPort.postMessage('dropped');
    } else parentPort.postMessage(held === '編🧶'.repeat(8192));
  });
  parentPort.postMessage('ready');
`);
  await once(consumer, "message");
  const token = native.retain("編🧶".repeat(8192));
  consumer.postMessage({ op: "adopt", token });
  assert.equal((await once(consumer, "message"))[0], true);
  native.release(token);
  collect?.();
  consumer.postMessage({ op: "read" });
  assert.equal((await once(consumer, "message"))[0], true);
  // Bun needs collection inside the worker before teardown to dispose external
  // string resources in the installed runtime; host GC cannot collect that heap.
  for (let i = 0; i < 3; i++) {
    consumer.postMessage({ op: "drop" });
    await once(consumer, "message");
  }
  await consumer.terminate();

  // Producer teardown discards registry holds but not consumer ownership.
  const producer = makeWorker(`
  parentPort.postMessage(native.retain('é🧶'.repeat(8192)));
  parentPort.on('message', () => {});
`);
  const workerToken = (await once(producer, "message"))[0];
  let held = native.adopt(workerToken);
  assert.equal(isExternal(held), true);
  await producer.terminate();
  assert.equal(native.stats().entries, 0);
  assert.throws(() => native.adopt(workerToken), /Released/);
  collect?.();
  assert.equal(held, "é🧶".repeat(8192));
  held = undefined;
}
await checkWorkers();

if (typeof collect !== "function") {
  throw new Error("Run with --expose-gc");
}
// Allow weak/GC cleanup to complete between turns; fail if resources leak.
for (let i = 0; i < 20 && native.stats().liveBytes > 0; i++) {
  await new Promise((resolve) => setImmediate(resolve));
  collect();
}
assert.equal(native.stats().entries, 0);
assert.equal(native.stats().liveBytes, 0);
console.log(
  JSON.stringify({
    runtime: globalThis.Bun
      ? `bun ${Bun.version}`
      : globalThis.Deno
      ? `deno ${Deno.version.deno}`
      : `node ${process.versions.node}`,
    lifetime:
      "content, sender release, producer teardown, consumer collection, GC reclamation passed",
    stats: native.stats(),
  }),
);
