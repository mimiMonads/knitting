import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "./_runner.ts";

const readVersion = (manifest: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${manifest}`, import.meta.url), "utf8"))
    .version;

// npm publishes package.json and JSR publishes deno.json; both have drifted
// apart before, so the same commit would ship as two different versions.
test("package.json and deno.json declare the same version", () => {
  const npm = readVersion("package.json");
  const jsr = readVersion("deno.json");
  assert.equal(
    jsr,
    npm,
    `deno.json is at ${jsr} but package.json is at ${npm}`,
  );
});
