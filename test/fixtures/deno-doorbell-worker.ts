import { createDenoCompletionNotifier } from "../../src/runtime/deno-doorbell.ts";

const args = new URL(import.meta.url).searchParams;
const encodedPointer = args.get("pointer");
const lane = Number(args.get("lane"));
if (encodedPointer !== null && Number.isInteger(lane)) {
  createDenoCompletionNotifier(BigInt(encodedPointer))?.(lane);
}
(globalThis as { postMessage?: (message: unknown) => void }).postMessage?.("done");
(globalThis as { close?: () => void }).close?.();
