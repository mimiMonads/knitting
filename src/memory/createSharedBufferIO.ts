
import { Buffer as NodeBuffer } from "node:buffer";
import { LockBound, TaskIndex } from "./lock.ts";
import {
  HAS_SAB_GROW,
  createSharedArrayBuffer,
} from "../common/runtime.ts";
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


  const maxBytes = 64 * 1024 * 1024;
  const initialBytes = HAS_SAB_GROW ? 4 * 1024 * 1024 : maxBytes;
  const lockSAB =
      sab ??
      createSharedArrayBuffer(
        initialBytes,
        maxBytes,
      );

  let u8 = new Uint8Array(lockSAB, SignalEnumOptions.header);
  const requireBufferView = (buffer: SharedArrayBuffer) => {
    const view = NodeBuffer.from(buffer, SignalEnumOptions.header);
    if (view.buffer !== buffer) {
      throw new Error("Buffer view does not alias SharedArrayBuffer");
    }
    return view;
  };
  let buf = requireBufferView(lockSAB);
  let f64 = new Float64Array(lockSAB, SignalEnumOptions.header);

  const capacityBytes = () => lockSAB.byteLength - SignalEnumOptions.header;

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return true;
    if (!HAS_SAB_GROW || typeof lockSAB.grow !== "function") return false;

    try {
      lockSAB.grow(
        alignUpto64(
          SignalEnumOptions.header + neededBytes + SignalEnumOptions.safePadding,
        ),
      );
    } catch {
      return false;
    }

    u8 = new Uint8Array(
      lockSAB,
      SignalEnumOptions.header,
      lockSAB.byteLength - SignalEnumOptions.header,
    );
    buf = requireBufferView(lockSAB);
    f64 = new Float64Array(
      lockSAB,
      SignalEnumOptions.header,
      (lockSAB.byteLength - SignalEnumOptions.header) >>> 3,
    );
    return true;
  };

  const readUtf8 = (start: number, end: number) => {
    return buf!.toString("utf8", start, end);
 
  };

  const writeBinary = (src: Uint8Array, start = 0) => {
    if (!ensureCapacity(start + src.byteLength)) {
      throw new RangeError("Shared buffer capacity exceeded");
    }
    u8.set(src, start);
    return src.byteLength;
  };

  const write8Binary = (src: Float64Array, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      throw new RangeError("Shared buffer capacity exceeded");
    }
    f64.set(src, start >>> 3);
    return bytes
  };

  const readBytesCopy = (start:number, end:number) => u8.slice(start,end);
  const readBytesView = (start:number, end:number) => u8.subarray(start,end);
  const readBytesBufferCopy = (start: number, end: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = NodeBuffer.allocUnsafe(length);
    if (length === 0) return out;
    buf.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (start: number, end: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = new Uint8Array(length);
    if (length === 0) return out.buffer;
    buf.copy(out, 0, start, end);
    return out.buffer;
  };

  const read8BytesFloatCopy = (start:number, end:number) =>
    f64.slice(start >>> 3, end >>> 3);
  const read8BytesFloatView = (start:number, end:number) =>
    f64.subarray(start >>> 3, end >>> 3);

  const writeUtf8 = (
    str: string,
    start: number,
    reservedBytes = str.length * 3,
  ) => {
    if (!ensureCapacity(start + reservedBytes)) {
      throw new RangeError("Shared buffer capacity exceeded");
    }

    return buf.write(str, start, reservedBytes, "utf8");
  };

  return {
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBytesArrayBufferCopy,
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
  const slotStride = LockBound.header + TaskIndex.TotalBuff;
  const writableBytes = (TaskIndex.TotalBuff - TaskIndex.Size) * u32Bytes;


  // Offsets are in Uint32 slots to match the header layout in lock.ts.
  const slotOffset = (at: number) =>
    (at * slotStride) + LockBound.header;
  const slotStartBytes = (at: number) =>
    (slotOffset(at) + TaskIndex.Size) * u32Bytes;

  
  
  const arrU8Sec = Array.from({
    length: LockBound.slots
  },
  (_,i) => new Uint8Array(headersBuffer, slotStartBytes(i), writableBytes))

  const arrBuffSec = Array.from(
    { length: LockBound.slots },
    (_, i) => NodeBuffer.from(headersBuffer, slotStartBytes(i), writableBytes),
  );

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
    const { read, written } = textEncode.encodeInto(str, arrU8Sec[at]);
    if (read !== str.length) return -1;
   
    return written;
  };

  const readUtf8 = (start: number, end: number,at:number) => {
    return arrBuffSec[at]!.toString("utf8", start, end);
  
  };

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
  const readBytesBufferCopy = (start: number, end: number, at: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = NodeBuffer.allocUnsafe(length);
    if (length === 0) return out;
    arrBuffSec[at]!.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (start: number, end: number, at: number) => {
    const length = Math.max(0, (end - start) | 0);
    const out = new Uint8Array(length);
    if (length === 0) return out.buffer;
    arrBuffSec[at]!.copy(out, 0, start, end);
    return out.buffer;
  };

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
    readBytesBufferCopy,
    readBytesArrayBufferCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes
  }





}
