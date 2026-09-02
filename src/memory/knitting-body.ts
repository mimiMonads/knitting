/**
 * One handle for a request body, whichever way it travels.
 *
 * `allocator.allocOrRefer()` deliberately returns two different things -- a
 * pooled region for a small body, a moved `BufferReference` for a large one --
 * because they are genuinely different transports. That is the right answer
 * for the allocator and the wrong one for a request handler, which then has to
 * branch, pick between two tasks, and get a different release rule right on
 * each side.
 *
 * `readBody()` keeps the choice and hides the branch. The host gets one
 * disposable handle; the worker gets a `Uint8Array`.
 *
 * Ownership: the host owns the body and lends it for the duration of the call.
 * The worker never releases anything -- a region is adopted with
 * `borrow: true`, so its `release()` cannot toggle an identity the host still
 * owns -- and the host's `using` scope is the lifetime. That is the same rule
 * for both transports, which is what makes the two sides uniform.
 *
 * The bytes are valid only until the host releases. A worker that wants to
 * keep them past the call must copy.
 */

import {
  attachKnittingAllocator,
  type KnittingAllocator,
  type KnittingBufferDescriptor,
} from "./knitting-buffer.ts";
import {
  BufferReference,
  isBufferReferenceValue,
} from "../connections/buffer-reference.ts";

/** What `allocator.transport()` hands a worker so it can attach once. */
export type KnittingTransport = ReturnType<KnittingAllocator["transport"]>;

/**
 * The value a body travels as. Three shapes, because a body has three homes:
 * the arena (a descriptor), the heap (a moved reference), or a standalone
 * buffer when the body did not fit the arena. `openBody` resolves all three.
 */
export type KnittingBodyWire =
  | KnittingBufferDescriptor
  | BufferReference
  | SharedArrayBuffer;

/** The host's handle: send `wire`, read `u8()`, and dispose when done. */
export type KnittingBody = {
  /** Pass this as the task argument. */
  readonly wire: KnittingBodyWire;
  readonly byteLength: number;
  /** The bytes on the host side, whichever transport was chosen. */
  u8(): Uint8Array;
  release(): void;
  [Symbol.dispose](): void;
};

const hasSharedArrayBuffer = typeof SharedArrayBuffer === "function";

/**
 * True for a buffer that arrived over a transport.
 *
 * knitting ships a SharedArrayBuffer by pointer and rebuilds it branded as an
 * ArrayBuffer, so `instanceof SharedArrayBuffer` is false on the far side even
 * though the memory is shared.
 */
const isTransportedBuffer = (value: unknown): value is SharedArrayBuffer =>
  (hasSharedArrayBuffer && value instanceof SharedArrayBuffer) ||
  value instanceof ArrayBuffer;

/**
 * Attach this worker to the host's arena and return the opener.
 *
 * Call it once per worker from a bootstrap module -- `transport()` nests
 * SharedArrayBuffers in an object, which survives the bootstrap's structured
 * clone but not a task payload's encoding.
 *
 * The returned function is total over `KnittingBodyWire`: whatever the host
 * chose, the task sees bytes.
 */
export const createBodyReader = (
  transport: KnittingTransport,
): ((wire: KnittingBodyWire) => Uint8Array) => {
  const lane = attachKnittingAllocator(transport);

  return (wire: KnittingBodyWire): Uint8Array => {
    // Moved: this worker holds the only live alias, and the host releases the
    // reference once the call settles.
    if (isBufferReferenceValue(wire)) return wire.toUint8Array();

    // A body too large for the arena travels as its own buffer. It carries no
    // identity, so there is nothing to borrow and nothing to release.
    if (isTransportedBuffer(wire)) return lane.adopt(wire).u8();

    // Pooled: borrowed for the call. `borrow` is what makes it impossible for
    // this worker to release an identity the host still owns.
    return lane.adopt(wire, { borrow: true }).u8();
  };
};
