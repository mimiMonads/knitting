/**
 * The server side of `bench/http-body-oha.ts`. One route per strategy for
 * getting a request body into a pooled shared-memory region, so a real load
 * generator can measure them end to end instead of timing inside the handler.
 *
 * Started by the orchestrator; run it directly to poke at a route by hand:
 *   PORT=3000 bun run bench/http-body-server.ts
 */

import { createKnittingAllocator } from "../src/memory/knitting-buffer.ts";
import { readBodyIntoRegion } from "../src/memory/knitting-buffer-http.ts";

const KIB = 1024;

const bun = (globalThis as unknown as {
  Bun?: {
    serve(o: unknown): { port: number };
    readableStreamToArrayBuffer(s: ReadableStream): Promise<ArrayBuffer>;
  };
}).Bun;

if (bun === undefined) throw new Error("bench/http-body-server.ts needs bun");

const env = (globalThis as unknown as {
  process: { env: Record<string, string | undefined> };
}).process.env;

const WINDOW = Number(env.KNITTING_WINDOW ?? 8 * 1024 * KIB);
const MAX_BODY = Number(env.KNITTING_MAX_BODY ?? 2 * 1024 * KIB);
const pool = createKnittingAllocator({ slots: 128, arenaByteLength: WINDOW });

type Handler = (req: Request) => Promise<void>;

const routes: Record<string, Handler> = {
  /** Touch nothing. The floor: routing and response only. */
  "/noop": async () => {},

  /** The cost of just getting a normal ArrayBuffer, and nothing else. */
  "/arrayBuffer": async (req) => {
    await req.arrayBuffer();
  },

  /** The same, via req.bytes(). */
  "/bytes": async (req) => {
    await (req as unknown as { bytes(): Promise<Uint8Array> }).bytes();
  },

  /** Materialize, then copy into a region: the double write. */
  "/arrayBufferRegion": async (req) => {
    const body = await req.arrayBuffer();
    const region = pool.alloc(body.byteLength);
    region.u8().set(new Uint8Array(body));
    region.release();
  },

  /** Double write, but sized from the body itself: no Content-Length needed. */
  "/bytesRegion": async (req) => {
    const body = await (req as unknown as { bytes(): Promise<Uint8Array> })
      .bytes();
    const region = pool.alloc(body.byteLength);
    region.u8().set(body);
    region.release();
  },

  /** Double write via bun's own stream drain. */
  "/bunDrainRegion": async (req) => {
    const body = await bun.readableStreamToArrayBuffer(
      req.body as ReadableStream,
    );
    const region = pool.alloc(body.byteLength);
    region.u8().set(new Uint8Array(body));
    region.release();
  },

  /** Single write: preallocate from Content-Length, read chunks into it. */
  "/streamRegion": async (req) => {
    const declared = Number(req.headers.get("content-length") ?? 0);
    const region = pool.alloc(declared);
    const out = region.u8();
    let at = 0;
    const reader = (req.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, at);
      at += value.byteLength;
    }
    region.release();
  },

  /**
   * The shipped policy: stream when the length is known and large enough,
   * materialize otherwise. Should track whichever of the two above is faster
   * at any given size.
   */
  "/policy": async (req) => {
    const region = await readBodyIntoRegion(req, pool);
    region.release();
  },

  /** Single write, no Content-Length: reserve an upper bound, then commit. */
  "/commitRegion": async (req) => {
    const region = pool.allocUpTo(MAX_BODY);
    const out = region.u8();
    let at = 0;
    const reader = (req.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, at);
      at += value.byteLength;
    }
    region.commit(at);
    region.release();
  },
};

const server = bun.serve({
  port: Number(env.PORT ?? 0),
  maxRequestBodySize: 64 * 1024 * KIB,
  async fetch(req: Request) {
    const path = new URL(req.url).pathname;

    if (path === "/stats") {
      return new Response(JSON.stringify(pool.stats()), {
        headers: { "content-type": "application/json" },
      });
    }

    const handler = routes[path];
    if (handler === undefined) return new Response("no such route", { status: 404 });

    await handler(req);
    return new Response("ok");
  },
});

console.log(`listening ${server.port}`);
console.log(`routes ${Object.keys(routes).join(" ")}`);
