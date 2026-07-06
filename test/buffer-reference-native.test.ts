import assert from "node:assert/strict";
import test from "./_runner.ts";
import {
  type BufferReferenceCapabilities,
  getBufferReferenceCapabilities,
} from "../src/connections/buffer-reference-native.ts";
import { detachArrayBufferBestEffort } from "../src/connections/buffer-reference.ts";

const isDetached = (buffer: ArrayBuffer): boolean =>
  (buffer as ArrayBuffer & { detached?: boolean }).detached === true ||
  buffer.byteLength === 0;

// Skip cleanly when FFI is unavailable.
const caps: BufferReferenceCapabilities | undefined = (() => {
  try {
    const c = getBufferReferenceCapabilities();
    const probe = c.produce(new Uint8Array([1, 2, 3, 4]));
    c.release(probe.token);
    return c;
  } catch {
    return undefined;
  }
})();

test("produce moves the source: the original buffer is detached", () => {
  if (!caps) return;

  const original = new Uint8Array([10, 20, 30, 40]);
  const buffer = original.buffer;
  const produced = caps.produce(original);
  try {
    assert.equal(isDetached(buffer), true, "source buffer should be detached");
    assert.equal(original.byteLength, 0, "source view should be emptied");
    assert.notEqual(produced.pointer, 0n);
    assert.equal(produced.byteLength, 4);
  } finally {
    caps.release(produced.token);
  }
});

test("adopt materializes the same bytes the producer moved", () => {
  if (!caps) return;

  const produced = caps.produce(new Uint8Array([5, 6, 7, 8]));
  try {
    const region = caps.adopt(produced);
    const view = new Uint8Array(
      region.buffer,
      region.byteOffset,
      region.byteLength,
    );
    assert.deepEqual([...view], [5, 6, 7, 8]);
  } finally {
    caps.release(produced.token);
  }
});

// CI canary for the revocation primitive `release()` relies on: adopted alias
// buffers must be detachable so escaped views can be neutralized before the
// producer pin drops. Guards future backends (e.g. Node 26 node:ffi).
test("adopted alias buffers are detachable (revocation primitive)", () => {
  if (!caps) return;

  const produced = caps.produce(new Uint8Array([1, 2, 3, 4]));
  try {
    const region = caps.adopt(produced);
    const view = new Uint8Array(
      region.buffer,
      region.byteOffset,
      region.byteLength,
    );
    const detached = detachArrayBufferBestEffort(caps.runtime, region.buffer);
    assert.equal(detached, true, "alias must be revocable");
    assert.equal(isDetached(region.buffer), true, "alias must be detached");
    assert.equal(view.byteLength, 0, "alias views must be revoked");
  } finally {
    caps.release(produced.token);
  }
});

test("produce accepts an ArrayBuffer directly", () => {
  if (!caps) return;

  const buffer = new Uint8Array([11, 12, 13, 14]).buffer;
  const produced = caps.produce(buffer);
  try {
    assert.equal(isDetached(buffer), true, "source buffer should be detached");
    assert.equal(produced.byteOffset, 0);
    assert.equal(produced.byteLength, 4);

    const region = caps.adopt(produced);
    const view = new Uint8Array(
      region.buffer,
      region.byteOffset,
      region.byteLength,
    );
    assert.deepEqual([...view], [11, 12, 13, 14]);
  } finally {
    caps.release(produced.token);
  }
});

test("two adopts of the same handle observe each other (shared backing store)", () => {
  if (!caps) return;

  const produced = caps.produce(new Uint8Array([0, 0, 0, 0]));
  try {
    const a = caps.adopt(produced);
    const b = caps.adopt(produced);
    const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

    av[0] = 99;
    av[3] = 7;
    assert.equal(bv[0], 99, "second adopt should see the first adopt's write");
    assert.equal(bv[3], 7);
  } finally {
    caps.release(produced.token);
  }
});

test("adopt with copy returns an independent buffer", () => {
  if (!caps) return;

  const produced = caps.produce(new Uint8Array([1, 1, 1, 1]));
  try {
    const alias = caps.adopt(produced);
    const copy = caps.adopt(produced, { copy: true });

    const aliasView = new Uint8Array(
      alias.buffer,
      alias.byteOffset,
      alias.byteLength,
    );
    const copyView = new Uint8Array(
      copy.buffer,
      copy.byteOffset,
      copy.byteLength,
    );

    assert.deepEqual([...copyView], [1, 1, 1, 1]);
    aliasView[0] = 42;
    assert.equal(
      copyView[0],
      1,
      "copy must not observe writes to the live backing store",
    );
    assert.notEqual(copy.buffer, alias.buffer);
  } finally {
    caps.release(produced.token);
  }
});

test("a typed-array view with a byte offset round-trips its region", () => {
  if (!caps) return;

  const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const slice = backing.subarray(2, 6);
  const produced = caps.produce(slice);
  try {
    assert.equal(produced.byteLength, 4);
    const region = caps.adopt(produced);
    const view = new Uint8Array(
      region.buffer,
      region.byteOffset,
      region.byteLength,
    );
    assert.deepEqual([...view], [2, 3, 4, 5]);
  } finally {
    caps.release(produced.token);
  }
});

test("release is idempotent and tolerates unknown tokens", () => {
  if (!caps) return;

  const produced = caps.produce(new Uint8Array([9]));
  caps.release(produced.token);
  caps.release(produced.token);
  caps.release(0xdead_beefn);
});

const sharedSupported = typeof SharedArrayBuffer === "function" &&
  caps !== undefined && (() => {
    try {
      const probe = caps.produceShared(new SharedArrayBuffer(8));
      caps.release(probe.token);
      return true;
    } catch {
      return false;
    }
  })();

test("produceShared shares a SAB by reference; adoptShared aliases the same bytes", () => {
  if (!caps || !sharedSupported) return;

  const sab = new SharedArrayBuffer(8);
  new Uint8Array(sab).set([1, 2, 3, 4, 5, 6, 7, 8]);

  const produced = caps.produceShared(sab);
  try {
    assert.equal(produced.byteLength, 8);

    const region = caps.adoptShared(produced);
    const view = new Uint8Array(
      region.buffer,
      region.byteOffset,
      region.byteLength,
    );
    assert.deepEqual([...view], [1, 2, 3, 4, 5, 6, 7, 8]);

    view[0] = 99;
    assert.equal(new Uint8Array(sab)[0], 99);
    new Uint8Array(sab)[7] = 42;
    assert.equal(view[7], 42);

    // Node can return a real SAB; Deno/Bun return aliases.
    assert.equal(region.isShared, caps.supportsSharedAdopt);
    if (region.isShared) {
      assert.ok(region.buffer instanceof SharedArrayBuffer);
    }
  } finally {
    caps.release(produced.token);
  }
});

test("produceShared does not detach the SAB (it stays usable on the producer)", () => {
  if (!caps || !sharedSupported) return;

  const sab = new SharedArrayBuffer(4);
  const produced = caps.produceShared(sab);
  try {
    assert.equal(sab.byteLength, 4);
    new Uint8Array(sab)[0] = 7;
    assert.equal(new Uint8Array(sab)[0], 7);
  } finally {
    caps.release(produced.token);
  }
});
