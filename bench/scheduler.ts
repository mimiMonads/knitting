import { bench, group, run as mitataRun } from "mitata";
import { format, print } from "./ulti/json-parse.ts";

type Scheduler = {
  name: string;
  schedule: (cb: () => void) => void;
};

type Channel = {
  schedule: (cb: () => void) => void;
  close: () => void;
};

const makeChannelScheduler = (): Channel | null => {
  const MC = (globalThis as { MessageChannel?: typeof MessageChannel })
    .MessageChannel;
  if (!MC) return null;

  const channel = new MC();
  const port1 = channel.port1 as unknown as {
    onmessage?: ((event: unknown) => void) | null;
    on?: (event: string, handler: () => void) => void;
    addEventListener?: (event: string, handler: () => void) => void;
    start?: () => void;
    close?: () => void;
  };
  const port2 = channel.port2 as unknown as {
    postMessage: (value: unknown) => void;
    start?: () => void;
    close?: () => void;
  };

  let pending: (() => void) | null = null;
  const handler = () => {
    if (!pending) return;
    const cb = pending;
    pending = null;
    cb();
  };

  if (typeof port1.onmessage !== "undefined") {
    port1.onmessage = handler;
  } else if (typeof port1.on === "function") {
    port1.on("message", handler);
  } else if (typeof port1.addEventListener === "function") {
    port1.addEventListener("message", handler);
  } else {
    return null;
  }

  if (typeof port1.start === "function") port1.start();
  if (typeof port2.start === "function") port2.start();

  return {
    schedule: (cb) => {
      pending = cb;
      port2.postMessage(null);
    },
    close: () => {
      if (typeof port1.close === "function") port1.close();
      if (typeof port2.close === "function") port2.close();
    },
  };
};

const isNode =
  typeof process !== "undefined" && typeof process.versions?.node === "string";

const schedulers: Scheduler[] = [];

if (typeof queueMicrotask === "function") {
  schedulers.push({ name: "queueMicrotask", schedule: queueMicrotask });
}

if (isNode && typeof process.nextTick === "function") {
  schedulers.push({
    name: "process.nextTick",
    schedule: (cb) => process.nextTick(cb),
  });
}

schedulers.push({
  name: "Promise.resolve().then",
  schedule: (cb) => Promise.resolve().then(cb),
});

if (typeof setImmediate === "function") {
  schedulers.push({ name: "setImmediate", schedule: (cb) => setImmediate(cb) });
}

if (typeof setTimeout === "function") {
  schedulers.push({ name: "setTimeout(0)", schedule: (cb) => setTimeout(cb, 0) });
}

const channel = makeChannelScheduler();
if (channel) {
  schedulers.unshift({
    name: "channelHandler.notify",
    schedule: channel.schedule,
  });
}

group("scheduler", () => {
  for (const { name, schedule } of schedulers) {
    bench(name, async () => {
      await new Promise<void>((resolve) => schedule(resolve));
    });
  }
});

await mitataRun({
  format,
  print,
});

if (channel) channel.close();
