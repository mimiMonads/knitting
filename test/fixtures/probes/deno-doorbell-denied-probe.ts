import { createDenoCompletionDoorbell } from "../../../src/runtime/deno-doorbell.ts";

if (createDenoCompletionDoorbell() !== undefined) {
  throw new Error("Deno doorbell unexpectedly ignored denied FFI permission");
}

console.log("deno doorbell fallback ok");
