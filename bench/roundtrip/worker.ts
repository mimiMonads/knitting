const isNode =
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string";

const setupMessaging = async (): Promise<{
  postMessage: (value: unknown) => void;
  onMessage: (handler: (message: unknown) => void) => void;
}> => {
  if (isNode) {
    const { parentPort } = await import("node:worker_threads");
    if (parentPort == null) {
      throw new Error("worker_threads parentPort is not available");
    }
    return {
      postMessage: (value) => parentPort.postMessage(value),
      onMessage: (handler) => {
        parentPort.on("message", handler);
      },
    };
  }

  const scope = globalThis as {
    postMessage?: (value: unknown) => void;
    onmessage?: (event: { data?: unknown }) => void;
    self?: {
      postMessage?: (value: unknown) => void;
      onmessage?: (event: { data?: unknown }) => void;
    };
  };
  const workerGlobal = scope.self ?? scope;

  return {
    postMessage: (value) => {
      const post = workerGlobal.postMessage ?? scope.postMessage;
      if (typeof post !== "function") {
        throw new Error("postMessage is not available in this worker");
      }
      post.call(workerGlobal, value);
    },
    onMessage: (handler) => {
      workerGlobal.onmessage = (event) => handler(event.data);
    },
  };
};

const { postMessage, onMessage } = await setupMessaging();

onMessage((message) => {
  try {
    if (!message || typeof message !== "object") return;
    const payload = message as {
      type?: string;
      id?: number;
      value?: unknown;
    };

    if (payload.type !== "echo" || typeof payload.id !== "number") {
      return;
    }

    postMessage({
      type: "result",
      id: payload.id,
      value: payload.value,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    postMessage({
      type: "error",
      message: err.message,
      stack: err.stack,
    });
  }
});
