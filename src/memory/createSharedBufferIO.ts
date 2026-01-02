
import { Buffer as NodeBuffer } from "node:buffer";
import { LockBound, Task, TaskIndex } from "./lock.ts";
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
        64 * 1024 * 1024,
        { maxByteLength: 64 * 1024 * 1024 },
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

// it has to be convert it to 8 
export const createSharedStaticBufferIO = ({
  headersBuffer,
}: {
  headersBuffer: SharedArrayBuffer 
}) => {


  const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
  const slotStride = LockBound.padding + TaskIndex.TotalBuff;
  const writableBytes = (TaskIndex.TotalBuff - TaskIndex.Size) * u32Bytes;


  // Offsets are in Uint32 slots to match the header layout in lock.ts.
  const slotOffset = (at: number) =>
    (at * slotStride) + LockBound.padding;
  const slotStartBytes = (at: number) =>
    (slotOffset(at) + TaskIndex.Size) * u32Bytes;

  
  
  const arrU8Sec = Array.from({
    length: LockBound.slots
  },
  (_,i) => new Uint8Array(headersBuffer, slotStartBytes(i), writableBytes))

  const arrBuffSec = Array.from({
    length: LockBound.slots
  },
  (_,i) => NodeBuffer.from(headersBuffer, slotStartBytes(i), writableBytes))

  const arrF64Sec = Array.from({
    length: LockBound.slots
  },
  (_,i) => new Float64Array(
    headersBuffer,
    slotStartBytes(i),
    writableBytes >>> 3
  ))

  const canWrite = (start: number, length: number) =>
    (start | 0) >= 0 && (start + length) <= writableBytes;



  const writeUtf8 = (str: string, at:number) => {
    const { written, read } = textEncode.encodeInto(str, 
      arrU8Sec[at]
    );

    if (read < str.length) {
      return -1
    }
    return written | 0

  };

  const readUtf8 = (start: number, end: number,at:number) => 
    arrBuffSec[at].toString("utf8", start, end);

  const writeBinary = (src: Uint8Array, at: number, start = 0) => {
    if (!canWrite(start, src.byteLength)) return -1;
    arrU8Sec[at].set(src, start);
    return src.byteLength;
  };

  const write8Binary = (src: Float64Array, at: number, start = 0) => {
    const bytes = src.byteLength;
    if (!canWrite(start, bytes)) return -1;
    arrF64Sec[at].set(src, start >>> 3);
    return bytes;
  };

  const readBytesCopy = (start:number, end:number, at:number) =>
    arrU8Sec[at].slice(start,end);
  const readBytesView = (start:number, end:number, at:number) =>
    arrU8Sec[at].subarray(start,end);

  const read8BytesFloatCopy = (start:number, end:number, at:number) =>
    arrF64Sec[at].slice(start >>> 3, end >>> 3);
  const read8BytesFloatView = (start:number, end:number, at:number) =>
    arrF64Sec[at].subarray(start >>> 3, end >>> 3);


  return{
    writeUtf8,
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes
  }





}
