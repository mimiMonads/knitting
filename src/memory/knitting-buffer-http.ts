/**
 * Read an HTTP request body into a pooled shared-memory region.
 *
 * Two strategies, because neither wins everywhere:
 *
 *   - **Materialize.** Let the runtime assemble the body on the heap, then
 *     copy it into a region. One copy, no per-chunk bookkeeping.
 *   - **Stream.** Preallocate a region of the declared length and write each
 *     chunk straight into it. No heap body at all, but a reader per request.
 *
 * A small body arrives as a single chunk, so streaming saves no copy and still
 * pays for the reader; a large one is split across many chunks, and there
 * writing straight into the region wins on p99 as much as on throughput. The
 * crossover is the body size at which chunking starts, so it depends on the
 * runtime and the network in front of it -- `HTTP_BODY_STREAM_THRESHOLD_BYTES`
 * is a starting point, not a constant of nature. `bench/http-body-oha.ts`
 * sweeps it.
 *
 * Streaming needs a length up front, so a body with no `Content-Length` is
 * always materialized. Reserving an upper bound instead is possible with
 * `allocator.allocUpTo()` but is a worse default: the reservation has to fit
 * the bump window, and a bound that does not fit takes the standalone-SAB
 * valve.
 */

import type {
  KnittingAllocator,
  KnittingSharedBuffer,
} from "./knitting-buffer.ts";
import { BufferReference } from "../connections/buffer-reference.ts";

/**
 * Bodies at least this large stream, if their length is known in advance.
 *
 * The crossover between the two strategies is runtime-dependent; re-measure
 * with `bench/http-body-oha.ts` if body sizes cluster near it.
 */
export const HTTP_BODY_STREAM_THRESHOLD_BYTES = 192 * 1024;

/**
 * Bodies at or above this size are moved with `BufferReference` by
 * `readBodyOrRefer`.
 *
 * Intentionally higher than `SHARED_RETURN_MIN_BYTES`, the crossover for an
 * already materialized buffer: request handling has to consume the stream
 * first, so the move only pays once the body is large enough to dominate that.
 * Tune it for the application's body sizes and in-flight request count.
 */
export const HTTP_BODY_REFERENCE_THRESHOLD_BYTES = 2 * 1024 * 1024;

export type ReadBodyOptions = {
  /**
   * Bodies of at least this many bytes stream into a preallocated region
   * instead of being materialized first. Below the crossover, streaming is
   * slower; see `HTTP_BODY_STREAM_THRESHOLD_BYTES`.
   */
  streamThresholdBytes?: number;
  /**
   * Reject a body larger than this.
   *
   * A declared length is a claim by the client, and the memory is committed
   * on the strength of that claim before a single byte arrives -- so an
   * unbounded default is a request-sized allocation primitive for anyone who
   * can send a header. A body that declares nothing is read against the same
   * cap rather than buffered whole and measured afterwards.
   *
   * `readBodyIntoRegion` defaults it to the allocator's `arenaByteLength`,
   * which is the most a pooled region can hold anyway. The helpers that
   * allocate somewhere else cannot infer a bound and require one.
   */
  maxByteLength?: number;
};

/** `readBodyIntoBytes` allocates through a caller-supplied function, so only
 * the caller knows what that allocation can afford. */
export type ReadBodyIntoBytesOptions = ReadBodyOptions & {
  maxByteLength: number;
};

/** `readBodyOrRefer` exists to handle bodies too large for the arena, so
 * neither the pool nor the crossover implies a bound. */
export type ReadBodyOrReferOptions = ReadBodyOptions & {
  maxByteLength: number;
  /** Move bodies at or above this size with `BufferReference`. */
  referenceAboveBytes?: number;
};

/** What these helpers need of an allocator: a region, and its ceiling. */
export type RegionAllocator = Pick<
  KnittingAllocator,
  "alloc" | "arenaByteLength"
>;

export type ReadBodyPayload = KnittingSharedBuffer | BufferReference;

type BytesCapableRequest = {
  bytes?: () => Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

/** The declared body length, or -1 when it is absent or not a sane integer. */
const declaredLength = (request: BytesCapableRequest): number => {
  const header = request.headers.get("content-length");
  if (header === null) return -1;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
};

/**
 * Read a body whose length was not declared, against `maxByteLength`.
 *
 * Buffering the whole thing and checking afterwards is the same exposure as
 * trusting `Content-Length`: an attacker only has to omit the header. Reading
 * against the cap stops at the first chunk that crosses it, and cancels the
 * stream so the sender stops rather than filling a socket buffer.
 */
const materialize = async (
  request: BytesCapableRequest,
  maxByteLength: number,
): Promise<Uint8Array> => {
  if (!Number.isFinite(maxByteLength) || request.body === null) {
    return request.bytes !== undefined
      ? await request.bytes()
      : new Uint8Array(await request.arrayBuffer());
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxByteLength) {
        await reader.cancel();
        throw new RangeError(
          `body is over the ${maxByteLength} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i]!, at);
    at += chunks[i]!.byteLength;
  }
  return out;
};

/**
 * Read `request`'s body into bytes from `allocate`.
 *
 * The generic form behind `readBodyIntoRegion`. `allocate` may be anything
 * that hands back a writable `Uint8Array` of the requested size -- a
 * `KnittingAllocator` region's view, or `pool.sharedArgBytes`, which borrows
 * from the arena the workers already read from, so the bytes reach a task
 * without a further copy.
 *
 * The returned view is exactly the bytes that arrived, which is not
 * necessarily what `Content-Length` claimed.
 */
export const readBodyIntoBytes = async (
  request: Request,
  allocate: (byteLength: number) => Uint8Array,
  {
    streamThresholdBytes = HTTP_BODY_STREAM_THRESHOLD_BYTES,
    maxByteLength,
  }: ReadBodyIntoBytesOptions,
): Promise<Uint8Array> => {
  const req = request as unknown as BytesCapableRequest;
  const declared = declaredLength(req);

  if (declared > maxByteLength) {
    throw new RangeError(
      `body declares ${declared} bytes, over the ${maxByteLength} limit`,
    );
  }

  if (declared >= streamThresholdBytes && req.body !== null) {
    const out = allocate(declared);
    let at = 0;
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > declared) {
          throw new RangeError(`body exceeds its declared ${declared} bytes`);
        }
        out.set(value, at);
        at += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return at === declared ? out : out.subarray(0, at);
  }

  const bytes = await materialize(req, maxByteLength);
  if (bytes.byteLength > maxByteLength) {
    throw new RangeError(
      `body is ${bytes.byteLength} bytes, over the ${maxByteLength} limit`,
    );
  }
  const out = allocate(bytes.byteLength);
  out.set(bytes);
  return out;
};

/**
 * Read `request`'s body into a region from `allocator`.
 *
 * The caller owns the region and must `release()` it (or let the
 * allocator's collector backstop reclaim it). The returned region's
 * `byteLength` is what
 * actually arrived, which is not necessarily what `Content-Length` claimed.
 */
export const readBodyIntoRegion = async (
  request: Request,
  allocator: RegionAllocator,
  {
    streamThresholdBytes = HTTP_BODY_STREAM_THRESHOLD_BYTES,
    // The arena is the ceiling on a pooled region: a larger body cannot be
    // pooled at all, it can only take the standalone-SAB valve, which is the
    // allocation an attacker would be aiming for.
    maxByteLength = allocator.arenaByteLength,
  }: ReadBodyOptions = {},
): Promise<KnittingSharedBuffer> => {
  const req = request as unknown as BytesCapableRequest;
  const declared = declaredLength(req);

  if (declared > maxByteLength) {
    throw new RangeError(
      `body declares ${declared} bytes, over the ${maxByteLength} limit`,
    );
  }

  // Stream only when the length is known and large enough to pay for it.
  if (declared >= streamThresholdBytes && req.body !== null) {
    const region = allocator.alloc(declared);
    try {
      const out = region.u8();
      let at = 0;
      const reader = req.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Content-Length is a claim, not a guarantee. Writing past the
          // region would corrupt whatever region follows it in the arena.
          if (at + value.byteLength > declared) {
            throw new RangeError(
              `body exceeds its declared ${declared} bytes`,
            );
          }
          out.set(value, at);
          at += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      // A body shorter than it claimed leaves a tail of stale arena bytes;
      // commit hands that tail back and reports the real length.
      return at === declared ? region : region.commit(at);
    } catch (error) {
      region.release();
      throw error;
    }
  }

  const bytes = await materialize(req, maxByteLength);
  if (bytes.byteLength > maxByteLength) {
    throw new RangeError(
      `body is ${bytes.byteLength} bytes, over the ${maxByteLength} limit`,
    );
  }

  const region = allocator.alloc(bytes.byteLength);
  try {
    region.u8().set(bytes);
    return region;
  } catch (error) {
    region.release();
    throw error;
  }
};

const copyBytesIntoRegion = (
  bytes: Uint8Array,
  allocator: RegionAllocator,
): KnittingSharedBuffer => {
  const region = allocator.alloc(bytes.byteLength);
  try {
    region.u8().set(bytes);
    return region;
  } catch (error) {
    region.release();
    throw error;
  }
};

/**
 * Read a request body into the representation that is cheaper to transport.
 *
 * Below `referenceAboveBytes`, the result is a `KnittingSharedBuffer` owned by
 * the supplied allocator. At or above it, the request is materialized into a
 * heap `ArrayBuffer` and moved into a `BufferReference`; constructing the
 * reference detaches the materialized source. The caller owns the result and
 * must release a `KnittingSharedBuffer` or `BufferReference` when finished.
 *
 * A missing `Content-Length` is materialized before choosing the result, so a
 * genuinely large chunked body still takes the reference path. This helper is
 * for thread workers; `BufferReference` cannot cross a process boundary.
 */
export const readBodyOrRefer = async (
  request: Request,
  allocator: RegionAllocator,
  {
    referenceAboveBytes = HTTP_BODY_REFERENCE_THRESHOLD_BYTES,
    ...bodyOptions
  }: ReadBodyOrReferOptions,
): Promise<ReadBodyPayload> => {
  if (
    !Number.isSafeInteger(referenceAboveBytes) || referenceAboveBytes < 0
  ) {
    throw new RangeError(
      "referenceAboveBytes must be a non-negative safe integer",
    );
  }

  const req = request as unknown as BytesCapableRequest;
  const declared = declaredLength(req);

  // A known-large body can stream directly into the heap buffer that will be
  // moved. A body without a length must also use this path so we can choose on
  // the actual byte count after consuming it.
  if (declared < 0 || declared >= referenceAboveBytes) {
    const bytes = await readBodyIntoBytes(
      request,
      (byteLength) => new Uint8Array(byteLength),
      bodyOptions,
    );

    if (bytes.byteLength >= referenceAboveBytes) {
      return new BufferReference(bytes);
    }
    return copyBytesIntoRegion(bytes, allocator);
  }

  return readBodyIntoRegion(request, allocator, bodyOptions);
};
