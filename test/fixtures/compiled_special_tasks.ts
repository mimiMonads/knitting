import { task } from "../../knitting.ts";

export const incrementBytes = task({
  f: (value: Uint8Array) => {
    const output = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) {
      output[index] = value[index]! + 1;
    }
    return output;
  },
});

export const incrementArrayBuffer = task({
  f: (value: ArrayBuffer) => {
    const input = new Uint8Array(value);
    const output = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index++) {
      output[index] = input[index]! + 1;
    }
    return output.buffer;
  },
});

export const incrementWords = task({
  f: (value: Int32Array) => {
    const output = new Int32Array(value.length);
    for (let index = 0; index < value.length; index++) {
      output[index] = value[index]! + 1;
    }
    return output;
  },
});

export const readDataView = task({
  f: (value: DataView) => value.getUint16(0, true),
});

export const readSharedBytes = task({
  f: (value: Uint8Array) => value[0]! + value[1]!,
});

export const sharedByteLength = task({
  f: (value: Uint8Array) => value.length,
});

export const readClock = task({
  abortSignal: true,
  f: (_value: number, signal) => signal.now() > 0,
});

export const echoObject = task({
  f: (value: Record<string, unknown>) => value,
});

export const repeatText = task({ f: (length: number) => "x".repeat(length) });

export const numberResult = task({
  f: (kind: number) =>
    kind === 0 ? -0 : kind === 1 ? NaN : kind === 2 ? Infinity : -Infinity,
});

export const escapedText = task({
  f: (_value: number) =>
    String.fromCharCode(
      0,
      34,
      92,
      8,
      12,
      10,
      13,
      9,
      0x7f,
      0x80,
      0xff,
    ),
});
