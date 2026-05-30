import { task } from "../../knitting.ts";

type BootstrapState = {
  value: string;
  sharedByteLength: number | null;
  thread: number;
  runtime: string;
};

type GlobalWithBootstrapState = typeof globalThis & {
  __knittingBootstrapState?: BootstrapState;
};

const importedState =
  (globalThis as GlobalWithBootstrapState).__knittingBootstrapState;

export const readBootstrapState = task<void, {
  importValue: string | undefined;
  runtimeValue: string | undefined;
  sharedByteLength: number | null | undefined;
  thread: number | undefined;
}>({
  f: () => {
    const runtimeState =
      (globalThis as GlobalWithBootstrapState).__knittingBootstrapState;
    return {
      importValue: importedState?.value,
      runtimeValue: runtimeState?.value,
      sharedByteLength: runtimeState?.sharedByteLength,
      thread: runtimeState?.thread,
    };
  },
});
