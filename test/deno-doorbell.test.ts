import assert from "node:assert/strict";
import test from "./_runner.ts";
import { RUNTIME } from "../src/common/runtime.ts";

const denoTestCapabilitiesGranted = (): boolean => {
  if (RUNTIME !== "deno") return false;
  const deno = (globalThis as typeof globalThis & {
    Deno?: {
      permissions?: {
        querySync?: (descriptor: { name: "ffi" | "run" }) => { state?: string };
      };
    };
  }).Deno;
  try {
    const query = deno?.permissions?.querySync;
    return query?.({ name: "ffi" }).state === "granted" &&
      query({ name: "run" }).state === "granted";
  } catch {
    return false;
  }
};

const denoRunGranted = (): boolean => {
  if (RUNTIME !== "deno") return false;
  const deno = (globalThis as typeof globalThis & {
    Deno?: {
      permissions?: {
        querySync?: (descriptor: { name: "run" }) => { state?: string };
      };
    };
  }).Deno;
  try {
    return deno?.permissions?.querySync?.({ name: "run" }).state === "granted";
  } catch {
    return false;
  }
};

test("Deno thread-safe completion doorbell wakes an idle host from a worker", {
  skip: !denoTestCapabilitiesGranted(),
}, async () => {
  const probe = new URL("./fixtures/probes/deno-doorbell-probe.ts", import.meta.url);
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", probe.href],
  }).output();
  assert.equal(output.success, true, new TextDecoder().decode(output.stderr));
  assert.match(new TextDecoder().decode(output.stdout), /doorbell ok/);
});

test("Deno doorbell falls back without prompting when FFI is denied", {
  skip: !denoRunGranted(),
}, async () => {
  const probe = new URL(
    "./fixtures/probes/deno-doorbell-denied-probe.ts",
    import.meta.url,
  );
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", "--deny-ffi", probe.href],
  }).output();
  assert.equal(output.success, true, new TextDecoder().decode(output.stderr));
  assert.match(new TextDecoder().decode(output.stdout), /doorbell fallback ok/);
});
