import { bench, group, run as mitataRun } from "mitata";
import { createPool, isMain, task } from "../knitting.ts";
import { TaskIndex } from "../src/memory/lock.ts";
import { format, print } from "./ulti/json-parse.ts";

export const echo = task<unknown, unknown>({
  f: async (value) => value,
});

if (isMain) {
  const { call, shutdown, send } = createPool({ threads: 1 })({ echo });

  const sizes = [1,100];

  const runBatch = async (n: number, payload: unknown) => {
    const arr = Array.from({ length: n }, () => call.echo(payload));
    send();
    await Promise.all(arr);
  };

  const jsonObj = {
    msg: "hello",
    data: "x".repeat(96),
    nums: Array.from({ length: 16 }, (_, i) => i),
    nested: { ok: true, list: [1, 2, 3, 4] },
  };

  const jsonArr = Array.from({ length: 16 }, (_, i) => ({ id: i, value: i * 2 }));

  const mapPayload = new Map<unknown, unknown>([
    ["a", 1],
    ["b", 2],
    ["c", 3],
    ["d", { ok: true }],
  ]);

  const setPayload = new Set<unknown>(["x", "y", 1, 2, 3]);

  const u8 = new Uint8Array(1024);
  for (let i = 0; i < u8.length; i++) u8[i] = i & 0xff;

  const i32 = new Int32Array(256);
  for (let i = 0; i < i32.length; i++) i32[i] = i;

  const f64 = new Float64Array(128);
  for (let i = 0; i < f64.length; i++) f64[i] = i + 0.5;

  const bi64 = new BigInt64Array(64);
  for (let i = 0; i < bi64.length; i++) bi64[i] = BigInt(i) - 32n;

  const bu64 = new BigUint64Array(64);
  for (let i = 0; i < bu64.length; i++) bu64[i] = BigInt(i);

  const dv = new DataView(new ArrayBuffer(1024));
  for (let i = 0; i < 128; i++) dv.setUint32(i * 4, i);

  const err = new Error("bench error");
  const date = new Date(1_700_000_000_000);
  const sym = Symbol.for("knitting.bench");

  const bigIntSmall = 123n;
  const bigIntLarge = 1n << 70n;
  const staticMaxBytes =
    (TaskIndex.TotalBuff - TaskIndex.Size) * Uint32Array.BYTES_PER_ELEMENT;
  const smallStaticBytes = Math.max(1, Math.min(32, staticMaxBytes - 1));
  const largeDynamicBytes = staticMaxBytes + 1;

  const smallString = "a".repeat(smallStaticBytes);
  const largeString = "a".repeat(largeDynamicBytes);
  const smallJson = { a: 1, b: "x" };
  const largeJson = { a: "x".repeat(largeDynamicBytes) };
  const smallU8 = new Uint8Array(smallStaticBytes);
  const largeU8 = new Uint8Array(largeDynamicBytes);
  const smallSymbol = Symbol.for("k".repeat(Math.max(1, smallStaticBytes - 1)));
  const largeSymbol = Symbol.for("k".repeat(largeDynamicBytes));

  
    for (const n of sizes) {
      group("knitting-types " + n, () => {
      bench(`number -> (${n})`, async () => await runBatch(n, 123.456));
      bench(`bigint small -> (${n})`, async () => await runBatch(n, bigIntSmall));
      bench(`bigint large -> (${n})`, async () => await runBatch(n, bigIntLarge));
      bench(`boolean true -> (${n})`, async () => await runBatch(n, true));
      bench(`boolean false -> (${n})`, async () => await runBatch(n, false));
      bench(`undefined -> (${n})`, async () => await runBatch(n, undefined));
      bench(`null -> (${n})`, async () => await runBatch(n, null));
      bench(`string -> (${n})`, async () => await runBatch(n, "helloWorld"));
      bench(`json object -> (${n})`, async () => await runBatch(n, jsonObj));
      bench(`json array -> (${n})`, async () => await runBatch(n, jsonArr));
      bench(`map -> (${n})`, async () => await runBatch(n, mapPayload));
      bench(`set -> (${n})`, async () => await runBatch(n, setPayload));
      bench(`Uint8Array -> (${n})`, async () => await runBatch(n, u8));
      bench(`Int32Array -> (${n})`, async () => await runBatch(n, i32));
      bench(`Float64Array -> (${n})`, async () => await runBatch(n, f64));
      bench(`BigInt64Array -> (${n})`, async () => await runBatch(n, bi64));
      bench(`BigUint64Array -> (${n})`, async () => await runBatch(n, bu64));
      bench(`DataView -> (${n})`, async () => await runBatch(n, dv));
      bench(`Error -> (${n})`, async () => await runBatch(n, err));
      bench(`Date -> (${n})`, async () => await runBatch(n, date));
      bench(`Symbol.for -> (${n})`, async () => await runBatch(n, sym));
       })
    }
;

  
    for (const n of sizes) {
      group("knitting-static-vs-allocator", () => {
      bench(`string static -> (${n})`, async () => await runBatch(n, smallString));
      bench(`string dynamic -> (${n})`, async () => await runBatch(n, largeString));
      bench(`json static -> (${n})`, async () => await runBatch(n, smallJson));
      bench(`json dynamic -> (${n})`, async () => await runBatch(n, largeJson));
      bench(`Uint8Array static -> (${n})`, async () => await runBatch(n, smallU8));
      bench(`Uint8Array dynamic -> (${n})`, async () => await runBatch(n, largeU8));
      bench(`Symbol static -> (${n})`, async () => await runBatch(n, smallSymbol));
      bench(`Symbol dynamic -> (${n})`, async () => await runBatch(n, largeSymbol));
      })
    }
 ;

  await mitataRun({ format, print });
  await shutdown();
}
