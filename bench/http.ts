import { bench, group, run as mitataRun } from "mitata";
import { Buffer } from "node:buffer";
import { createPool, isMain, task } from "../knitting.ts";
import { format, print } from "./ulti/json-parse.ts";

const payloadText = JSON.stringify({
  msg: "hello",
  data: "x".repeat(1024),
  nums: Array.from({ length: 32 }, (_, i) => i),
});

const contentType = "application/json; charset=utf-8";

export const echo = task({
  f: (value: string) => value,
});

const { call, send, shutdown } = createPool({})({ echo });

type ServerHandle = {
  url: string;
  close: () => Promise<void>;
};

const handleRequest = async (req: Request): Promise<Response> => {
  const body = req.method === "POST" ? await req.text() : "";
  return new Response(body || payloadText, {
    status: 200,
    headers: { "content-type": contentType },
  });
};

const startServer = async (): Promise<ServerHandle> => {
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
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.end(body || payloadText);
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
  await res.text();
};

if (isMain) {
  const server = await startServer();
  const sizes = [1, 10, 50, 100];

  group("knitting", () => {
    for (const n of sizes) {
      bench(`1 thread → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => call.echo(payloadText));
        send();
        await Promise.all(arr);
      });
    }
  });

  group("http", () => {
    for (const n of sizes) {
      bench(`local → (${n})`, async () => {
        const arr = Array.from({ length: n }, () => post(server.url, payloadText));
        await Promise.all(arr);
      });
    }
  });

  await mitataRun({ format, print });
  await server.close();
  await shutdown();
}
