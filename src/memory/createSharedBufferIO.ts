
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

export const createSharedBufferIO = ({
  sab,
}: {
  sab: SharedArrayBuffer; 
}) => {
  let u8 = new Uint8Array(sab, SignalEnumOptions.header);
  let buf = NodeBuffer.from(sab, SignalEnumOptions.header);
  let f64 = new Float64Array(sab, SignalEnumOptions.header);

  const capacityBytes = () => sab.byteLength - SignalEnumOptions.header;

  const ensureCapacity = (neededBytes: number) => {
    if (capacityBytes() >= neededBytes) return;

    sab.grow(
      alignUpto64(
        SignalEnumOptions.header + neededBytes + SignalEnumOptions.safePadding,
      ),
    );

    u8 = new Uint8Array(
      sab,
      SignalEnumOptions.header,
      sab.byteLength - SignalEnumOptions.header,
    );
    buf = NodeBuffer.from(
      sab,
      SignalEnumOptions.header,
      sab.byteLength - SignalEnumOptions.header,
    );
    f64 = new Float64Array(
      sab,
      SignalEnumOptions.header,
      (sab.byteLength - SignalEnumOptions.header) >>> 3,
    );
  };

  const readUtf8 = (start: number, end: number) => buf.toString("utf8", start, end);

  const writeBinary = (src: Uint8Array) => {
    ensureCapacity(src.byteLength);
    u8.set(src, 0);
    return src.byteLength;
  };

  const write8Binary = (src: Float64Array) => {
    const bytes = src.byteLength;
    ensureCapacity(bytes);
    f64.set(src, 0);
    return bytes
  };

  const readBytesCopy = (start:number, end:number) => u8.slice(start,end);
  const readBytesView = (start:number, end:number) => u8.subarray(start,end);

//   const read8BytesFloatCopy = () => f64.slice(0, payloadLen[0] >>> 3);
//   const read8BytesFloatView = () => f64.subarray(0, payloadLen[0] >>> 3);

  const writeUtf8 = (str: string) => {
    const { written, read } = textEncode.encodeInto(str, u8);

    if (read < str.length) {
      return writeBinary(textEncode.encode(str));
    }
    return written

  };

  return {
    readUtf8,
    writeBinary,
    write8Binary,
    readBytesCopy,
    readBytesView,
    // read8BytesFloatCopy,
    // read8BytesFloatView,
    writeUtf8,
  };
};