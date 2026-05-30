type BootstrapState = {
  value: string;
  sharedByteLength: number | null;
  thread: number;
  runtime: string;
};

type GlobalWithBootstrapState = typeof globalThis & {
  __knittingBootstrapState?: BootstrapState;
};

export const setup = async (
  data: unknown,
  context: { thread: number; runtime: string },
) => {
  await Promise.resolve();
  const record = data as {
    value?: unknown;
    shared?: { byteLength?: unknown };
  };
  const sharedByteLength = typeof record.shared?.byteLength === "number"
    ? record.shared.byteLength
    : null;
  (globalThis as GlobalWithBootstrapState).__knittingBootstrapState = {
    value: String(record.value ?? ""),
    sharedByteLength,
    thread: context.thread,
    runtime: context.runtime,
  };
};

export const fail = async () => {
  await Promise.resolve();
  throw new Error("bootstrap failed");
};
