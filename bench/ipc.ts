import { bench, group, run as mitataRun } from "mitata";
import { Buffer } from "node:buffer";
import { createPool, isMain, task } from "../knitting.ts";
import { toResolve, shutdownWorkers } from "./postmessage/single.ts";
import { format, print } from "./ulti/json-parse.ts";

const payloadObject = {
  msg: "hello world",
  id: 32
};

const payloadText = JSON.stringify(payloadObject);
const contentType = "application/json; charset=utf-8";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toText = (data: unknown) => {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return textDecoder.decode(data);
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return String(data);
};

const parseJson = (data: unknown) => JSON.parse(toText(data));

type ServerHandle = {
  url: string;
  close: () => Promise<void>;
};

const handleRequest = async (req: Request): Promise<Response> => {
  const body = req.method === "POST" ? await req.text() : "";
  const parsed = body ? JSON.parse(body) : payloadObject;
  const reply = JSON.stringify(parsed);
  return new Response(reply, {
    status: 200,
    headers: { "content-type": contentType },
  });
};

const startHttpServer = async (): Promise<ServerHandle> => {
  const isBun = typeof Bun !== "undefined";
  const isDeno = typeof Deno !== "undefined";

  if (isBun && typeof Bun.serve === "function") {
    const server = Bun.serve({
      port: 0,
      fetch: handleRequest,
    });
    return {
      url: `http://127.0.0.1:${server.port}/echo`,
      close: async () => {
        server.stop();
      },
    };
  }

  if (isDeno && typeof Deno.serve === "function") {
    const controller = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: controller.signal },
      handleRequest,
    );
    const addr = server.addr as Deno.NetAddr;
    return {
      url: `http://127.0.0.1:${addr.port}/echo`,
      close: async () => {
        controller.abort();
        await server.finished;
      },
    };
  }

  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    req.on("data", (chunk) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = body ? JSON.parse(body) : payloadObject;
      const reply = JSON.stringify(parsed);
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.end(reply);
    });
    req.on("error", () => {
      res.statusCode = 500;
      res.end("error");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/echo`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};

const post = async (url: string, body: string) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  parseJson(await res.text());
};

const concatUint8 = (a: Uint8Array, b: Uint8Array) => {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

type ParsedFrame = {
  opcode: number;
  payload: Uint8Array;
  nextIndex: number;
};

const decodeFrame = (buffer: Uint8Array): ParsedFrame | null => {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = (buffer[2] << 8) | buffer[3];
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const high = view.getUint32(2);
    const low = view.getUint32(6);
    const big = high * 2 ** 32 + low;
    if (big > Number.MAX_SAFE_INTEGER) {
      throw new Error("WebSocket frame too large");
    }
    length = big;
    offset = 10;
  }

  let mask: Uint8Array | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  let payloadBytes = buffer.subarray(offset, offset + length);

  if (masked && mask) {
    const unmasked = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      unmasked[i] = payloadBytes[i] ^ mask[i & 3];
    }
    payloadBytes = unmasked;
  }

  return {
    opcode,
    payload: payloadBytes,
    nextIndex: offset + length,
  };
};

const encodeFrame = (payloadBytes: Uint8Array, opcode = 0x1) => {
  const length = payloadBytes.length;
  let header: Uint8Array;

  if (length <= 125) {
    header = new Uint8Array(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = length;
  } else if (length < 65_536) {
    header = new Uint8Array(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header[2] = (length >> 8) & 0xff;
    header[3] = length & 0xff;
  } else {
    header = new Uint8Array(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    const view = new DataView(header.buffer);
    const high = Math.floor(length / 2 ** 32);
    const low = length >>> 0;
    view.setUint32(2, high);
    view.setUint32(6, low);
  }

  const out = new Uint8Array(header.length + length);
  out.set(header, 0);
  out.set(payloadBytes, header.length);
  return out;
};

const startWebSocketServer = async (): Promise<ServerHandle> => {
  const isBun = typeof Bun !== "undefined";
  const isDeno = typeof Deno !== "undefined";

  if (isBun && typeof Bun.serve === "function") {
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("upgrade", { status: 426 });
      },
      websocket: {
        message(ws, message) {
          const parsed = parseJson(message);
          ws.send(JSON.stringify(parsed));
        },
      },
    });

    return {
      url: `ws://127.0.0.1:${server.port}`,
      close: async () => {
        server.stop();
      },
    };
  }

  if (isDeno && typeof Deno.serve === "function" && typeof Deno.upgradeWebSocket === "function") {
    const controller = new AbortController();
    const server = Deno.serve({ port: 0, signal: controller.signal }, (req) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("upgrade", { status: 426 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => {
        const parsed = parseJson(event.data);
        socket.send(JSON.stringify(parsed));
      };
      return response;
    });

    const addr = server.addr as Deno.NetAddr;
    return {
      url: `ws://127.0.0.1:${addr.port}`,
      close: async () => {
        controller.abort();
        await server.finished;
      },
    };
  }

  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const sockets = new Set<{
    write: (data: Uint8Array) => void;
    destroy: () => void;
    on: (event: string, handler: (...args: any[]) => void) => void;
    end: (data?: Uint8Array) => void;
  }>();

  const server = createServer();
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

  server.on("upgrade", (req: any, socket: any) => {
    const keyHeader = req.headers["sec-websocket-key"] as string | string[] | undefined;
    if (!keyHeader || Array.isArray(keyHeader)) {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${keyHeader}${GUID}`)
      .digest("base64");

    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ];

    socket.write(headers.join("\r\n"));
    sockets.add(socket);

    let buffer = new Uint8Array();

    socket.on("data", (chunk: Uint8Array) => {
      buffer = concatUint8(buffer, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));

      while (true) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.nextIndex);

        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(new Uint8Array(), 0x8));
          return;
        }

        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xA));
          continue;
        }

        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          const parsed = parseJson(frame.payload);
          const reply = textEncoder.encode(JSON.stringify(parsed));
          socket.write(encodeFrame(reply, 0x1));
        }
      }
    });

    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });
    },
  };
};

const connectClient = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);

    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      resolve(ws);
    };

    const onError = (event: Event) => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      reject(event);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });

const createSendMany = (ws: WebSocket, body: string) => {
  let pending = 0;
  let resolve: (() => void) | null = null;
  let reject: ((reason?: unknown) => void) | null = null;

  ws.addEventListener("message", (event) => {
    if (pending <= 0) return;
    parseJson(event.data);
    pending -= 1;
    if (pending === 0 && resolve) {
      const done = resolve;
      resolve = null;
      reject = null;
      done();
    }
  });

  ws.addEventListener("error", (event) => {
    if (!reject) return;
    const fail = reject;
    resolve = null;
    reject = null;
    pending = 0;
    fail(event);
  });

  return (count: number) => {
    if (count <= 0) return Promise.resolve();
    if (pending !== 0) {
      return Promise.reject(new Error("WebSocket batch overlap"));
    }

    return new Promise<void>((done, fail) => {
      pending = count;
      resolve = done;
      reject = fail;
      for (let i = 0; i < count; i++) ws.send(body);
    });
  };
};

export const echo = task({
  f: (value: typeof payloadObject) => value,
});

if (isMain) {
  const { call, send, shutdown } = createPool({ threads: 1 })({ echo });
  const httpServer = await startHttpServer();
  const wsServer = await startWebSocketServer();
  const ws = await connectClient(wsServer.url);
  const sendMany = createSendMany(ws, payloadText);

  await call.echo(payloadObject);
  send();
  await toResolve(payloadObject);
  await post(httpServer.url, payloadText);
  await sendMany(1);

  const sizes = [1, 50, 100];

  group("knitting", () => {
    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => call.echo(payloadObject));
        send();
        await Promise.all(arr);
      });
    }
  });


  group("websocket", () => {
    for (const n of sizes) {
      bench(`local → (${n})`, async () => {
        await sendMany(n);
      });
    }
  });

  group("worker", () => {
    for (const n of sizes) {
      bench(`postMessage → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => toResolve(payloadObject));
        await Promise.all(arr);
      });
    }
  });

  group("http", () => {
    for (const n of sizes) {
      bench(`local → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => post(httpServer.url, payloadText));
        await Promise.all(arr);
      });
    }
  });



  await mitataRun({ format, print });

  const closeWait = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener("close", () => resolve());
  });
  ws.close();
  await closeWait;

  await wsServer.close();
  await httpServer.close();
  await shutdown();
  await shutdownWorkers();
}
