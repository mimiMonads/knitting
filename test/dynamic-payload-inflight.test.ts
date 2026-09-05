import assert from "node:assert/strict";
import test from "./_runner.ts";
import { createPool } from "../knitting.ts";
import { stampedBytes, stampedString } from "./fixtures/inflight_payload_tasks.ts";

// Dynamic payload regions have 64 identities even though transport headers
// retain 32 queue slots. When all 64 are live, the existing lock pending list
// retries the frame after a receiver releases one. Static payloads (<= 512 B)
// remain inline.
const ROUNDS = 40;
const PAYLOAD_BYTES = 8192;

const runInflight = async (inflight: number) => {
  const pool = createPool({ threads: 1 })({ stampedBytes, stampedString });
  let corruptBytes = 0;
  let corruptStrings = 0;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const stamps = Array.from({ length: inflight }, (_, j) => (j % 250) + 1);
      const packed = stamps.map((stamp) => (stamp << 21) | PAYLOAD_BYTES);

      const bytes = await Promise.all(packed.map((p) => pool.call.stampedBytes(p)));
      for (let j = 0; j < inflight; j++) {
        const out = bytes[j]!;
        if (
          out.byteLength !== PAYLOAD_BYTES ||
          out[0] !== stamps[j] ||
          out[PAYLOAD_BYTES - 1] !== stamps[j]
        ) {
          corruptBytes++;
        }
      }

      const strings = await Promise.all(
        packed.map((p) => pool.call.stampedString(p)),
      );
      for (let j = 0; j < inflight; j++) {
        const out = strings[j]!;
        const want = String.fromCharCode(65 + (stamps[j]! % 26));
        if (
          out.length !== PAYLOAD_BYTES ||
          out[0] !== want ||
          out[PAYLOAD_BYTES - 1] !== want
        ) {
          corruptStrings++;
        }
      }
    }
  } finally {
    await pool.shutdown();
  }
  return { corruptBytes, corruptStrings, total: ROUNDS * inflight };
};

test("dynamic payloads are intact below the transport-slot limit", async () => {
  const { corruptBytes, corruptStrings, total } = await runInflight(28);
  assert.equal(corruptBytes, 0, `${corruptBytes}/${total} Uint8Array payloads corrupt`);
  assert.equal(corruptStrings, 0, `${corruptStrings}/${total} string payloads corrupt`);
});

test("dynamic payloads survive 64 calls in flight", async () => {
  const { corruptBytes, corruptStrings, total } = await runInflight(64);
  assert.equal(
    corruptBytes,
    0,
    `${corruptBytes}/${total} Uint8Array payloads corrupt`,
  );
  assert.equal(
    corruptStrings,
    0,
    `${corruptStrings}/${total} string payloads corrupt`,
  );
});

test("calls above the 64-region cap are queued without corruption", async () => {
  const { corruptBytes, corruptStrings, total } = await runInflight(80);
  assert.equal(
    corruptBytes,
    0,
    `${corruptBytes}/${total} Uint8Array payloads corrupt`,
  );
  assert.equal(
    corruptStrings,
    0,
    `${corruptStrings}/${total} string payloads corrupt`,
  );
});
