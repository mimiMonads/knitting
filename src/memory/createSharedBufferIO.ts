
import { Buffer as NodeBuffer } from "node:buffer";
const page = 1024 * 4;

const textEncode = new TextEncoder();

enum SignalEnumOptions {
  header = 64,
  maxByteLength = page * page,
  defaultSize = page,
  safePadding = page,
}

const alignUpto64 = (n: number) => (n + (64 - 1)) & ~(64 - 1);

export const createSharedDynamicBufferIO = ({
  sab,
}: {
  sab?: SharedArrayBuffer; 
}) => {


  const lockSAB =
      sab ??
      new SharedArrayBuffer(
        40000,
      );

  let u8 = new Uint8Array(lockSAB, SignalEnumOptions.header);
  let buf = NodeBuffer.from(lockSAB, SignalEnumOptions.header);
  let f64 = new Float64Array(lockSAB, SignalEnumOptions.header);

  const capacityBytes = () => lockSAB.byteLength - SignalEnumOptions.header;

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return;

    lockSAB.grow(
      alignUpto64(
        SignalEnumOptions.header + neededBytes + SignalEnumOptions.safePadding,
      ),
    );

    u8 = new Uint8Array(
      lockSAB,
      SignalEnumOptions.header,
      lockSAB.byteLength - SignalEnumOptions.header,
    );
    buf = NodeBuffer.from(
      lockSAB,
      SignalEnumOptions.header,
      lockSAB.byteLength - SignalEnumOptions.header,
    );
    f64 = new Float64Array(
      lockSAB,
      SignalEnumOptions.header,
      (lockSAB.byteLength - SignalEnumOptions.header) >>> 3,
    );
  };

  const readUtf8 = (start: number, end: number) => buf.toString("utf8", start, end);

  const writeBinary = (src: Uint8Array, start = 0) => {
    ensureCapacity(start + src.byteLength);
    u8.set(src, start);
    return src.byteLength;
  };

  const write8Binary = (src: Float64Array, start = 0) => {
    const bytes = src.byteLength;
    ensureCapacity(start + bytes);
    f64.set(src, start >>> 3);
    return bytes
  };

  const readBytesCopy = (start:number, end:number) => u8.slice(start,end);
  const readBytesView = (start:number, end:number) => u8.subarray(start,end);

  const read8BytesFloatCopy = (start:number, end:number) =>
    f64.slice(start >>> 3, end >>> 3);
  const read8BytesFloatView = (start:number, end:number) =>
    f64.subarray(start >>> 3, end >>> 3);

  const writeUtf8 = (str: string, start: number) => {
    const { written, read } = textEncode.encodeInto(str, 
      u8.subarray(start)
    );

    if (read < str.length) {
      return writeBinary(textEncode.encode(str), start);
    }
    return written

  };

  return {
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    read8BytesFloatCopy,
    read8BytesFloatView,
    writeUtf8,
  };
};
