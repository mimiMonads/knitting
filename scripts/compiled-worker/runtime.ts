/// <reference path="./porffor.d.ts" />

type WorkerAbortSignal = { hasAborted: () => boolean; now: () => number };
type WorkerFunction = (value: unknown, signal: WorkerAbortSignal) => unknown;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const READ_EOF = -2147483648;
const input = new Uint8Array(MAX_PAYLOAD_BYTES);
const output = new Uint8Array(MAX_PAYLOAD_BYTES);
const sharedName = new Uint8Array(256);

const dataPointer = (view: Uint8Array): number => {
  let pointer: i32 = 0;
  Porffor.c`
pointer = *(i32*)(MEM + (i32)view.val + 4) + 4;
`;
  return pointer;
};

const inputPointer = dataPointer(input);
const outputPointer = dataPointer(output);

Porffor.c`
#include <time.h>

static i32 knit_json_read_exact(void* output, i32 length) {
  u8* cursor = (u8*)output;
  i32 remaining = length;
  while (remaining > 0) {
    long count = read(STDIN_FILENO, cursor, (size_t)remaining);
    if (count == 0) return 0;
    if (count < 0) return -1;
    cursor += count;
    remaining -= (i32)count;
  }
  return 1;
}

static i32 knit_json_request_length = 0;
static i32 knit_json_abort_signal = -1;

static volatile int* knit_abort_words = (volatile int*)0;
static i32 knit_abort_bytes = 0;

/*
 * CLOCK_MONOTONIC is what performance.now() reports on the other lanes, so
 * signal.now() deltas stay immune to wall-clock steps. Letting time.h supply
 * struct timespec also avoids hand-rolling an ABI: a hand-declared timeval
 * would have needed a 32-bit tv_usec on macOS and a 64-bit one on Linux.
 */
static f64 knit_now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0.0;
  return (f64)ts.tv_sec * 1000.0 + (f64)ts.tv_nsec / 1000000.0;
}

static i32 knit_abort_open(void) {
  extern char* getenv(const char*);
  extern int shm_open(const char*, int, unsigned int);
  extern void* mmap(void*, unsigned long, int, int, int, long);
  extern int close(int);
  const int knit_abort_o_rdwr = 2;
  const int knit_abort_prot_read = 1;
  const int knit_abort_map_shared = 1;
  char* name = getenv("KNITTING_COMPILED_ABORT_SHM");
  char* bytesText = getenv("KNITTING_COMPILED_ABORT_BYTES");
  if (name == (char*)0 || bytesText == (char*)0) return 0;
  i32 bytes = 0;
  while (*bytesText >= '0' && *bytesText <= '9') {
    bytes = bytes * 10 + (*bytesText - '0');
    bytesText++;
  }
  if (bytes <= 0) return 0;
  int fd = shm_open(name, knit_abort_o_rdwr, 0600);
  if (fd < 0) return 0;
  void* mapped = mmap(
    (void*)0,
    (unsigned long)bytes,
    knit_abort_prot_read,
    knit_abort_map_shared,
    fd,
    0
  );
  close(fd);
  if (mapped == (void*)-1) return 0;
  knit_abort_words = (volatile int*)mapped;
  knit_abort_bytes = bytes;
  return 1;
}

static i32 knit_abort_has(i32 signal) {
  if (knit_abort_words == (volatile int*)0 || signal < 0) return 0;
  i32 word = signal >> 5;
  if ((word + 1) * 4 > knit_abort_bytes) return 0;
  i32 value = __atomic_load_n(knit_abort_words + word, __ATOMIC_SEQ_CST);
  return (value & (1 << (signal & 31))) != 0;
}

static i32 knit_map_named_shm(i32 namePtr, i32 hintOff, i32 bytes) {
  extern int shm_open(const char*, int, unsigned int);
  extern void* mmap(void*, unsigned long, int, int, int, long);
  extern int close(int);
  extern void perror(const char*);
  const int knit_shm_o_rdwr = 2;
  const int knit_shm_prot_read = 1;
  const int knit_shm_prot_write = 2;
  const int knit_shm_map_shared = 1;
  const int knit_shm_map_fixed = 16;
  int fd = shm_open((char*)(MEM + namePtr), knit_shm_o_rdwr, 0600);
  if (fd < 0) { perror("knit compiled shm_open"); return -1; }
  char* base = MEM + hintOff;
  unsigned long aligned = ((unsigned long)base + 4095UL) & ~4095UL;
  void* mapped = mmap(
    (void*)aligned,
    (unsigned long)bytes,
    knit_shm_prot_read | knit_shm_prot_write,
    knit_shm_map_shared | knit_shm_map_fixed,
    fd,
    0
  );
  close(fd);
  if (mapped == (void*)-1) { perror("knit compiled mmap"); return -1; }
  return (i32)((u8*)mapped - MEM);
}

static i32 knit_json_read_request(i32 pointer, i32 capacity) {
  i32 header[3] = {0};
  if (knit_json_read_exact(header, (i32)sizeof(header)) != 1) {
    return (i32)0x80000000u;
  }
  i32 task_index = header[0];
  knit_json_abort_signal = header[1];
  i32 length = header[2];
  if (task_index == -1) return -1;
  if (length < 0 || length > capacity) return -2;
  if (knit_json_read_exact(MEM + pointer, length) != 1) {
    return (i32)0x80000000u;
  }
  knit_json_request_length = length;
  return task_index;
}

static i32 knit_json_write_exact(const void* input, i32 length) {
  const u8* cursor = (const u8*)input;
  i32 remaining = length;
  while (remaining > 0) {
    long count = write(STDOUT_FILENO, cursor, (size_t)remaining);
    if (count <= 0) return -1;
    cursor += count;
    remaining -= (i32)count;
  }
  return 0;
}

static i32 knit_json_write_response(i32 status, i32 pointer, i32 length) {
  i32 header[2] = {status, length};
  if (knit_json_write_exact(header, (i32)sizeof(header)) != 0) return -1;
  return knit_json_write_exact(MEM + pointer, length);
}
`;

const readRequest = (pointer: number, capacity: number): number => {
  let taskIndex: i32 = 0;
  Porffor.c`
taskIndex = knit_json_read_request((i32)pointer.val, (i32)capacity.val);
`;
  return taskIndex;
};

const requestLength = (): number => {
  let length: i32 = 0;
  Porffor.c`length = knit_json_request_length;`;
  return length;
};

const writeResponse = (
  status: number,
  pointer: number,
  length: number,
): number => {
  let result: i32 = 0;
  Porffor.c`
result = knit_json_write_response(
  (i32)status.val,
  (i32)pointer.val,
  (i32)length.val
);
`;
  return result;
};

const abortSignal: WorkerAbortSignal = {
  hasAborted: (): boolean => {
    let result: i32 = 0;
    Porffor.c`result = knit_abort_has(knit_json_abort_signal);`;
    return result !== 0;
  },
  now: (): number => {
    let result = 0;
    Porffor.c`result = knit_now_ms();`;
    return result;
  },
};

const dataPointerOf = (view: Uint8Array): number => {
  let pointer: i32 = 0;
  Porffor.c`pointer = *(i32*)(MEM + (i32)view.val + 4) + 4;`;
  return pointer;
};

const sharedNamePointer = dataPointerOf(sharedName);

const mapProcessShared = (name: string, size: number): number => {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code > 0x7f) throw new TypeError("Compiled shared names must be ASCII");
    sharedName[index] = code;
  }
  sharedName[name.length] = 0;
  let mapped: i32 = 0;
  const scratch = new Uint8Array(size + 8192);
  const hint = dataPointerOf(scratch);
  Porffor.c`
mapped = knit_map_named_shm(
  (i32)sharedNamePointer.val,
  (i32)hint.val,
  (i32)size.val
);`;
  if (mapped < 0) throw new Error("Compiled ProcessSharedBuffer mapping failed");
  return mapped;
};

/**
 * A mapping permanently claims linear memory, so each name is mapped once and
 * every later call reuses the base pointer. Without this, a task called in a
 * loop would grow the process by its buffer size on every single call.
 */
const mappedNames: string[] = [];
const mappedBases: number[] = [];

const processSharedView = (
  name: string,
  size: number,
  offset: number,
  length: number,
): Uint8Array => {
  if (name.length === 0 || name.length >= sharedName.length) {
    throw new TypeError("Compiled ProcessSharedBuffer name is invalid");
  }
  if (size <= 0 || offset < 0 || length < 0 || offset + length > size) {
    throw new RangeError("Compiled ProcessSharedBuffer range is invalid");
  }
  let base = -1;
  for (let index = 0; index < mappedNames.length; index++) {
    if (mappedNames[index] === name) base = mappedBases[index]!;
  }
  if (base < 0) {
    base = mapProcessShared(name, size);
    mappedNames.push(name);
    mappedBases.push(base);
  }
  const view = new Uint8Array(1);
  // Porffor's element access ignores a view's byteOffset field, so the offset
  // is folded into the buffer pointer instead and the field is left at zero.
  // The trailing -4 steps back over the length prefix Porffor keeps in front
  // of buffer data.
  Porffor.c`
*(i32*)(MEM + (i32)view.val) = (i32)length.val;
*(i32*)(MEM + (i32)view.val + 4) = (i32)base.val + (i32)offset.val - 4;
*(i32*)(MEM + (i32)view.val + 8) = 0;
`;
  return view;
};

/*
 * Base64 keeps binary values inside the ASCII request budget at four characters
 * per three bytes. A JSON array of decimal bytes costs up to four characters
 * per single byte, so a buffer barely over 250 KiB could not fit in a frame at
 * all. Both halves map sextets to character codes arithmetically, so neither
 * needs to index into an alphabet string: 0-25 are A-Z, 26-51 a-z, 52-61 0-9,
 * then + and /. Unknown codes, padding included, contribute no bits.
 */
const base64Code = (sextet: number): number =>
  sextet < 26
    ? 65 + sextet
    : sextet < 52
    ? 71 + sextet
    : sextet < 62
    ? sextet - 4
    : sextet === 62
    ? 43
    : 47;

const base64Sextet = (code: number): number => {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return 0;
};

const toBase64 = (view: Uint8Array): string => {
  let text = "";
  for (let at = 0; at < view.length; at += 3) {
    const remaining = view.length - at;
    const word = (view[at]! << 16) |
      (remaining > 1 ? view[at + 1]! << 8 : 0) |
      (remaining > 2 ? view[at + 2]! : 0);
    text += String.fromCharCode(
      base64Code((word >> 18) & 63),
      base64Code((word >> 12) & 63),
    );
    text += remaining > 1
      ? String.fromCharCode(base64Code((word >> 6) & 63))
      : "=";
    text += remaining > 2 ? String.fromCharCode(base64Code(word & 63)) : "=";
  }
  return text;
};

const fromBase64 = (text: string): Uint8Array => {
  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 61) {
    padding++;
  }
  const bytes = new Uint8Array((text.length >> 2) * 3 - padding);
  let at = 0;
  for (let index = 0; index + 3 < text.length; index += 4) {
    const word = (base64Sextet(text.charCodeAt(index)) << 18) |
      (base64Sextet(text.charCodeAt(index + 1)) << 12) |
      (base64Sextet(text.charCodeAt(index + 2)) << 6) |
      base64Sextet(text.charCodeAt(index + 3));
    bytes[at++] = (word >> 16) & 255;
    if (at < bytes.length) bytes[at++] = (word >> 8) & 255;
    if (at < bytes.length) bytes[at++] = word & 255;
  }
  return bytes;
};

const decodeWireValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = decodeWireValue(value[index]);
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const tag = record["$knitting"];
  if (typeof tag === "string") {
    if (tag === "process-shared") {
      return processSharedView(
        record.name as string,
        record.size as number,
        record.offset as number,
        record.length as number,
      );
    }
    const bytes = fromBase64(record.data as string);
    if (tag === "array-buffer") return bytes.buffer;
    if (tag === "data-view") return new DataView(bytes.buffer);
    if (tag === "u8") return bytes;
    if (tag === "u8c") return new Uint8ClampedArray(bytes.buffer);
    if (tag === "i8") return new Int8Array(bytes.buffer);
    if (tag === "u16") return new Uint16Array(bytes.buffer);
    if (tag === "i16") return new Int16Array(bytes.buffer);
    if (tag === "u32") return new Uint32Array(bytes.buffer);
    if (tag === "i32") return new Int32Array(bytes.buffer);
    if (tag === "f32") return new Float32Array(bytes.buffer);
    if (tag === "f64") return new Float64Array(bytes.buffer);
    throw new TypeError("Compiled worker received an unknown binary value");
  }
  for (const key of Object.keys(record)) {
    record[key] = decodeWireValue(record[key]);
  }
  return value;
};

const binaryTagOf = (value: unknown): string => {
  if (value instanceof ArrayBuffer) return "array-buffer";
  if (value instanceof DataView) return "data-view";
  if (value instanceof Uint8Array) return "u8";
  if (value instanceof Uint8ClampedArray) return "u8c";
  if (value instanceof Int8Array) return "i8";
  if (value instanceof Uint16Array) return "u16";
  if (value instanceof Int16Array) return "i16";
  if (value instanceof Uint32Array) return "u32";
  if (value instanceof Int32Array) return "i32";
  if (value instanceof Float32Array) return "f32";
  if (value instanceof Float64Array) return "f64";
  return "";
};

const encodeWireValue = (value: unknown): unknown => {
  const tag = binaryTagOf(value);
  if (tag !== "") {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(
        (value as ArrayBufferView).buffer,
        (value as ArrayBufferView).byteOffset,
        (value as ArrayBufferView).byteLength,
      );
    return { $knitting: tag, data: toBase64(bytes) };
  }
  if (Array.isArray(value)) return value.map(encodeWireValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = encodeWireValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

const decodeUtf8 = (length: number): string => {
  let text = "";
  let index = 0;
  while (index < length) {
    const first = input[index++]!;
    if (first < 0x80) {
      text += String.fromCharCode(first);
      continue;
    }

    if (first < 0xe0) {
      const second = input[index++]!;
      text += String.fromCharCode(
        ((first & 0x1f) << 6) | (second & 0x3f),
      );
      continue;
    }

    if (first < 0xf0) {
      const second = input[index++]!;
      const third = input[index++]!;
      text += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
      continue;
    }

    const second = input[index++]!;
    const third = input[index++]!;
    const fourth = input[index++]!;
    const point = ((first & 0x07) << 18) | ((second & 0x3f) << 12) |
      ((third & 0x3f) << 6) | (fourth & 0x3f);
    const adjusted = point - 0x10000;
    text += String.fromCharCode(
      0xd800 + (adjusted >> 10),
      0xdc00 + (adjusted & 0x3ff),
    );
  }
  return text;
};

const encodeUtf8 = (text: string): number => {
  let offset = 0;
  for (let index = 0; index < text.length; index++) {
    let point = text.charCodeAt(index);
    if (
      point >= 0xd800 && point <= 0xdbff && index + 1 < text.length
    ) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }

    if (point < 0x80) {
      if (offset + 1 > MAX_PAYLOAD_BYTES) return -1;
      output[offset++] = point;
    } else if (point < 0x800) {
      if (offset + 2 > MAX_PAYLOAD_BYTES) return -1;
      output[offset++] = 0xc0 | (point >> 6);
      output[offset++] = 0x80 | (point & 0x3f);
    } else if (point < 0x10000) {
      if (offset + 3 > MAX_PAYLOAD_BYTES) return -1;
      output[offset++] = 0xe0 | (point >> 12);
      output[offset++] = 0x80 | ((point >> 6) & 0x3f);
      output[offset++] = 0x80 | (point & 0x3f);
    } else {
      if (offset + 4 > MAX_PAYLOAD_BYTES) return -1;
      output[offset++] = 0xf0 | (point >> 18);
      output[offset++] = 0x80 | ((point >> 12) & 0x3f);
      output[offset++] = 0x80 | ((point >> 6) & 0x3f);
      output[offset++] = 0x80 | (point & 0x3f);
    }
  }
  return offset;
};

/**
 * Requests use a twelve-byte little-endian header: i32 task index, i32 abort
 * slot, and i32 byte length, followed by UTF-8 JSON. Responses keep the
 * original eight-byte status/length header.
 */
export const runJsonWorker = (functions: WorkerFunction[]): void => {
  Porffor.c`knit_abort_open();`;
  while (true) {
    const taskIndex = readRequest(inputPointer, MAX_PAYLOAD_BYTES);
    if (taskIndex === READ_EOF || taskIndex === -1) return;
    if (taskIndex < 0 || taskIndex >= functions.length) {
      if (writeResponse(1, outputPointer, 0) !== 0) return;
      continue;
    }

    try {
      const value = decodeWireValue(JSON.parse(decodeUtf8(requestLength())));
      const result = functions[taskIndex]!(value, abortSignal);
      const serialized = JSON.stringify(encodeWireValue(result));
      if (typeof serialized !== "string") {
        if (writeResponse(2, outputPointer, 0) !== 0) return;
        continue;
      }
      const length = encodeUtf8(serialized);
      if (length < 0) {
        if (writeResponse(4, outputPointer, 0) !== 0) return;
        continue;
      }
      if (writeResponse(0, outputPointer, length) !== 0) return;
    } catch (_error) {
      if (writeResponse(3, outputPointer, 0) !== 0) return;
    }
  }
};
