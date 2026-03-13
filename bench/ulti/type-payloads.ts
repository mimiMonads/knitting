import { Buffer as NodeBuffer } from "node:buffer";

export type BenchPayloadCase = readonly [name: string, payload: unknown];

const WASM_PAGE_BYTES = 64 * 1024;
const wasmArenaOwners = new WeakMap<
  ArrayBuffer | SharedArrayBuffer,
  WebAssembly.Memory
>();

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

const createWasmArena = (minimumByteLength: number) => {
  const pages = Math.max(1, Math.ceil(minimumByteLength / WASM_PAGE_BYTES));
  const memory = new WebAssembly.Memory({
    initial: pages,
    maximum: pages,
  });
  const buffer = memory.buffer;
  wasmArenaOwners.set(buffer, memory);

  let nextOffset = 0;
  const reserve = (byteLength: number, alignment = 1): number => {
    const byteOffset = alignTo(nextOffset, alignment);
    const end = byteOffset + byteLength;
    if (end > buffer.byteLength) {
      throw new RangeError(
        `Wasm arena exhausted: requested ${byteLength} bytes, ${
          buffer.byteLength - byteOffset
        } remaining.`,
      );
    }
    nextOffset = end;
    return byteOffset;
  };

  return { buffer, reserve };
};

const fillByteRamp = (view: Uint8Array, seed = 0): Uint8Array => {
  for (let i = 0; i < view.length; i++) view[i] = (seed + i) & 0xff;
  return view;
};

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

  const jsonArr = Array.from(
    { length: 11 },
    (_, i) => ({ id: i, value: i * 2 }),
  );

  const arena = createWasmArena(1024 * 6);
  const u8Offset = arena.reserve(1024);
  const u8 = fillByteRamp(new Uint8Array(arena.buffer, u8Offset, 1024));
  const stringHuge = "x".repeat(u8.byteLength);
  const arrayBufferValue = arena.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  );
  const bufferValue = NodeBuffer.from(
    arena.buffer,
    u8.byteOffset,
    u8.byteLength,
  );

  const i32Offset = arena.reserve(
    Int32Array.BYTES_PER_ELEMENT * 256,
    Int32Array.BYTES_PER_ELEMENT,
  );
  const i32 = new Int32Array(arena.buffer, i32Offset, 256);
  for (let i = 0; i < i32.length; i++) i32[i] = i;

  const f64Offset = arena.reserve(
    Float64Array.BYTES_PER_ELEMENT * 128,
    Float64Array.BYTES_PER_ELEMENT,
  );
  const f64 = new Float64Array(arena.buffer, f64Offset, 128);
  for (let i = 0; i < f64.length; i++) f64[i] = i + 0.5;

  const bi64Offset = arena.reserve(
    BigInt64Array.BYTES_PER_ELEMENT * 128,
    BigInt64Array.BYTES_PER_ELEMENT,
  );
  const bi64 = new BigInt64Array(arena.buffer, bi64Offset, 128);
  for (let i = 0; i < bi64.length; i++) bi64[i] = BigInt(i) - 32n;

  const bu64Offset = arena.reserve(
    BigUint64Array.BYTES_PER_ELEMENT * 128,
    BigUint64Array.BYTES_PER_ELEMENT,
  );
  const bu64 = new BigUint64Array(arena.buffer, bu64Offset, 128);
  for (let i = 0; i < bu64.length; i++) bu64[i] = BigInt(i);

  const dvOffset = arena.reserve(1024, Uint32Array.BYTES_PER_ELEMENT);
  const dv = new DataView(arena.buffer, dvOffset, 1024);
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
    ["string huge", stringHuge],
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

export const createStaticBoundaryCases = (
  staticMaxBytes: number,
): BenchPayloadCase[] => [
  ["string static", "a".repeat(staticMaxBytes)],
  ["string dynamic", "a".repeat(staticMaxBytes + 1)],
  ["json static", { a: "x".repeat(staticMaxBytes - 12) }],
  ["json dynamic", { a: "x".repeat(staticMaxBytes + 1) }],
  ...(() => {
    const arena = createWasmArena((staticMaxBytes * 2) + 1);
    const staticView = fillByteRamp(
      new Uint8Array(
        arena.buffer,
        arena.reserve(staticMaxBytes),
        staticMaxBytes,
      ),
      17,
    );
    const dynamicView = fillByteRamp(
      new Uint8Array(
        arena.buffer,
        arena.reserve(staticMaxBytes + 1),
        staticMaxBytes + 1,
      ),
      33,
    );
    return [
      ["Uint8Array static", staticView],
      ["Uint8Array dynamic", dynamicView],
    ] as BenchPayloadCase[];
  })(),
  ["Symbol static", Symbol.for("k".repeat(Math.max(1, staticMaxBytes - 1)))],
  ["Symbol dynamic", Symbol.for("k".repeat(staticMaxBytes + 1))],
];

export const createStringLength3xCases = (): BenchPayloadCase[] => [
  ["string len 159", "a".repeat(159)],
  ["string len 160", "a".repeat(160)],
];

export const estimatePayloadBytes = (value: unknown): number => {
  if (value === null || value === undefined) return 0;

  if (typeof value === "string") return NodeBuffer.byteLength(value, "utf-8");
  if (typeof value === "number") return Float64Array.BYTES_PER_ELEMENT;
  if (typeof value === "boolean") return 1;
  if (typeof value === "bigint") {
    const n = value < 0n ? -value : value;
    const bits = (n === 0n ? 1 : n.toString(2).length) + 1;
    return Math.ceil(bits / 8);
  }
  if (typeof value === "symbol") {
    return NodeBuffer.byteLength(String(value.description ?? ""), "utf-8");
  }
  if (typeof value === "function") return 0;

  if (value instanceof Date) return Float64Array.BYTES_PER_ELEMENT;
  if (value instanceof Error) {
    return NodeBuffer.byteLength(value.name, "utf-8") +
      NodeBuffer.byteLength(value.message, "utf-8");
  }
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Promise) return 0;
  if (typeof value === "object") {
    try {
      return NodeBuffer.byteLength(JSON.stringify(value), "utf-8");
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

  const arena = createWasmArena((staticMaxBytes * 2) + 1);
  const smallU8 = fillByteRamp(
    new Uint8Array(arena.buffer, arena.reserve(staticMaxBytes), staticMaxBytes),
    49,
  );
  const largeU8 = fillByteRamp(
    new Uint8Array(
      arena.buffer,
      arena.reserve(staticMaxBytes + 1),
      staticMaxBytes + 1,
    ),
    81,
  );

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
    ["smallU8", smallU8],
    ["largeU8", largeU8],
  ];
};
