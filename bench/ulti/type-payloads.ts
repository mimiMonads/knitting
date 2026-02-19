import { Buffer as NodeBuffer } from "node:buffer";

export type BenchPayloadCase = readonly [name: string, payload: unknown];

export const createSharedTypePayloadCases = () => {
  const numberValue = 123.456;
  const bigIntSmall = 123n;
  const bigIntLarge = 1n << 70n;
  const stringValue = "helloWorld";

  const jsonObj = {
    msg: "hello",
    data: "x".repeat(96),
    nums: Array.from({ length: 16 }, (_, i) => i),
    nested: { ok: true, list: [1, 2, 3, 4] },
  };

  const jsonArr = Array.from({ length: 11 }, (_, i) => ({ id: i, value: i * 2 }));

  const u8 = new Uint8Array(1024);
  for (let i = 0; i < u8.length; i++) u8[i] = i & 0xff;
  const stringHuge = "x".repeat(u8.byteLength);
  const arrayBufferValue = u8.buffer.slice(0);
  const bufferValue = NodeBuffer.from(u8);

  const i32 = new Int32Array(256);
  for (let i = 0; i < i32.length; i++) i32[i] = i;

  const f64 = new Float64Array(128);
  for (let i = 0; i < f64.length; i++) f64[i] = i + 0.5;

  const bi64 = new BigInt64Array(128);
  for (let i = 0; i < bi64.length; i++) bi64[i] = BigInt(i) - 32n;

  const bu64 = new BigUint64Array(128);
  for (let i = 0; i < bu64.length; i++) bu64[i] = BigInt(i);

  const dv = new DataView(new ArrayBuffer(1024));
  for (let i = 0; i < 128; i++) dv.setUint32(i * 4, i);

  const date = new Date(1_700_000_000_000);
  const symbolValue = Symbol.for("knitting.bench");

  const promiseNumber = Promise.resolve(numberValue);
  const promiseJson = Promise.resolve({ ok: true, payload: "x".repeat(32) });

  const comparableCases: BenchPayloadCase[] = [
    ["number", numberValue],
    ["bigint small", bigIntSmall],
    ["bigint large", bigIntLarge],
    ["boolean true", true],
    ["boolean false", false],
    ["undefined", undefined],
    ["null", null],
    ["string", stringValue],
    ["string huge", stringHuge],
    ["json object", jsonObj],
    ["json array", jsonArr],
    ["Uint8Array", u8],
    ["ArrayBuffer", arrayBufferValue],
    ["Buffer", bufferValue],
    ["Int32Array", i32],
    ["Float64Array", f64],
    ["BigInt64Array", bi64],
    ["BigUint64Array", bu64],
    ["DataView", dv],
    ["Date", date],
  ];

  const knittingOnlyCases: BenchPayloadCase[] = [
    ["Symbol.for", symbolValue],
  ];

  const promiseCases: BenchPayloadCase[] = [
    ["promise number", promiseNumber],
    ["promise object", promiseJson],
  ];

  return {
    comparableCases,
    knittingOnlyCases,
    promiseCases,
  };
};

export const createStaticBoundaryCases = (staticMaxBytes: number): BenchPayloadCase[] => [
  ["string static", "a".repeat(staticMaxBytes)],
  ["string dynamic", "a".repeat(staticMaxBytes + 1)],
  ["json static", { a:  "x".repeat(staticMaxBytes - 12)}],
  ["json dynamic", { a: "x".repeat(staticMaxBytes + 1) }],
  ["Uint8Array static", new Uint8Array(staticMaxBytes)],
  ["Uint8Array dynamic", new Uint8Array(staticMaxBytes + 1)],
  ["Symbol static", Symbol.for("k".repeat(Math.max(1, staticMaxBytes - 1)))],
  ["Symbol dynamic", Symbol.for("k".repeat(staticMaxBytes + 1))],
];

export const createStringLength3xCases = (): BenchPayloadCase[] => [
  ["string len 159", "a".repeat(159)],
  ["string len 160", "a".repeat(160)],
];

export const estimatePayloadBytes = (value: unknown): number => {
  if (value === null || value === undefined) return 0;

  const valueType = typeof value;
  if (valueType === "string") return Buffer.byteLength(value, "utf-8");
  if (valueType === "number") return Float64Array.BYTES_PER_ELEMENT;
  if (valueType === "boolean") return 1;
  if (valueType === "bigint") {
    const n = value < 0n ? -value : value;
    const bits = (n === 0n ? 1 : n.toString(2).length) + 1;
    return Math.ceil(bits / 8);
  }
  if (valueType === "symbol") {
    return Buffer.byteLength(String(value.description ?? ""), "utf-8");
  }
  if (valueType === "function") return 0;

  if (value instanceof Date) return Float64Array.BYTES_PER_ELEMENT;
  if (value instanceof Error) {
    return Buffer.byteLength(value.name, "utf-8") + Buffer.byteLength(value.message, "utf-8");
  }
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Promise) return 0;
  if (valueType === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf-8");
    } catch {
      return 0;
    }
  }
  return 0;
};

export const createPayloadSizeCases = (
  comparableCases: ReadonlyArray<BenchPayloadCase>,
  staticMaxBytes: number,
): BenchPayloadCase[] => {
  const pick = (name: string) => {
    const found = comparableCases.find(([candidate]) => candidate === name);
    const payload = found?.[1];
    if (payload === undefined) throw new Error(`Missing payload case: ${name}`);
    return payload;
  };

  return [
    ["jsonObj", pick("json object")],
    ["jsonArr", pick("json array")],
    ["stringHuge", pick("string huge")],
    ["Uint8Array", pick("Uint8Array")],
    ["Int32Array", pick("Int32Array")],
    ["Float64Array", pick("Float64Array")],
    ["BigInt64Array", pick("BigInt64Array")],
    ["BigUint64Array", pick("BigUint64Array")],
    ["DataView", pick("DataView")],
    ["smallU8", new Uint8Array(staticMaxBytes)],
    ["largeU8", new Uint8Array(staticMaxBytes + 1)],
  ];
};
