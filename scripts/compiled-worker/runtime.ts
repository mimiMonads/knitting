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
#include <errno.h>
#include <sys/uio.h>
#include <stdlib.h>
#include <math.h>

/* Read ahead across frame boundaries when the host sends a batch. Never wait
   for a full buffer: a single request must still receive an immediate reply. */
static u8 knit_input_buffer[65536];
static i32 knit_input_used = 0;
static i32 knit_input_end = 0;

static i32 knit_json_read_exact(void* output, i32 length) {
  u8* cursor = (u8*)output;
  i32 remaining = length;
  while (remaining > 0) {
    if (knit_input_used == knit_input_end) {
      long count = read(STDIN_FILENO, knit_input_buffer, sizeof(knit_input_buffer));
      if (count == 0) return 0;
      if (count < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      knit_input_used = 0;
      knit_input_end = (i32)count;
    }
    i32 count = knit_input_end - knit_input_used;
    if (count > remaining) count = remaining;
    memcpy(cursor, knit_input_buffer + knit_input_used, (size_t)count);
    knit_input_used += count;
    cursor += count;
    remaining -= (i32)count;
  }
  return 1;
}

static i32 knit_base64_sextet(i32 code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code == 43) return 62;
  if (code == 47) return 63;
  return 0;
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

static i32 knit_json_write_response(i32 status, i32 pointer, i32 length) {
  i32 header[2] = {status, length};
  struct iovec parts[2] = {
    {header, sizeof(header)},
    {MEM + pointer, (size_t)length}
  };
  i32 first = 0;
  i32 end = length == 0 ? 1 : 2;
  while (first < end) {
    long count = writev(STDOUT_FILENO, parts + first, end - first);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    while (first < end && (size_t)count >= parts[first].iov_len) {
      count -= parts[first].iov_len;
      first++;
    }
    if (first < end) {
      parts[first].iov_base = (u8*)parts[first].iov_base + count;
      parts[first].iov_len -= count;
    }
  }
  return 0;
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
  // Use a local C binding: newer Porffor versions mangle module globals.
  const namePointer = sharedNamePointer;
  Porffor.c`
mapped = knit_map_named_shm(
  (i32)namePointer.val,
  (i32)hint.val,
  (i32)size.val
);`;
  if (mapped < 0) {
    throw new Error("Compiled ProcessSharedBuffer mapping failed");
  }
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

/* Binary values stay inside JSON as Base64. Fill a preallocated ASCII string
 * once rather than repeatedly copying an ever-growing string per quartet. */
const toBase64 = (view: Uint8Array): string => {
  const text = " ".repeat(Math.ceil(view.length / 3) * 4);
  const pointer = dataPointerOf(view);
  const length = view.length;
  Porffor.c`
const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const u8* bytes = (u8*)(MEM + (i32)pointer.val);
u8* destination = (u8*)(MEM + (i32)text.val + 4);
i32 count = (i32)length.val;
for (i32 at = 0, out = 0; at < count; at += 3, out += 4) {
  i32 remaining = count - at;
  u32 word = ((u32)bytes[at] << 16)
    | (remaining > 1 ? (u32)bytes[at + 1] << 8 : 0)
    | (remaining > 2 ? bytes[at + 2] : 0);
  destination[out] = alphabet[(word >> 18) & 63];
  destination[out + 1] = alphabet[(word >> 12) & 63];
  destination[out + 2] = remaining > 1 ? alphabet[(word >> 6) & 63] : '=';
  destination[out + 3] = remaining > 2 ? alphabet[word & 63] : '=';
}
`;
  return text;
};

const fromBase64 = (text: string): Uint8Array => {
  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 61) {
    padding++;
  }
  const bytes = new Uint8Array((text.length >> 2) * 3 - padding);
  const pointer = dataPointerOf(bytes);
  const length = text.length;
  const capacity = bytes.length;
  Porffor.c`
/* Strings use either one-byte or UTF-16 storage. Base64 is ASCII in both;
   Porffor marks the one-byte representation with the high type bit. */
const u8* characters = (u8*)(MEM + (i32)text.val + 4);
i32 stride = ((i32)text.type & 0x80) ? 1 : 2;
u8* destination = (u8*)(MEM + (i32)pointer.val);
i32 out = 0;
for (i32 at = 0; at + 3 < (i32)length.val; at += 4) {
  u32 word = ((u32)knit_base64_sextet(characters[at * stride]) << 18)
    | ((u32)knit_base64_sextet(characters[(at + 1) * stride]) << 12)
    | ((u32)knit_base64_sextet(characters[(at + 2) * stride]) << 6)
    | (u32)knit_base64_sextet(characters[(at + 3) * stride]);
  destination[out++] = (word >> 16) & 255;
  if (out < (i32)capacity.val) destination[out++] = (word >> 8) & 255;
  if (out < (i32)capacity.val) destination[out++] = word & 255;
}
`;
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
    if (tag === "object") {
      const entries = record.entries as unknown[][];
      const object: Record<string, unknown> = Object.create(null);
      for (let index = 0; index < entries.length; index++) {
        Object.defineProperty(object, entries[index]![0] as string, {
          value: decodeWireValue(entries[index]![1]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return object;
    }
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
  if (value === null || typeof value !== "object") return value;
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
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const entry = encodeWireValue((value as Record<string, unknown>)[key]);
      if (key === "__proto__") {
        Object.defineProperty(out, key, {
          value: entry,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else out[key] = entry;
    }
    if (Object.hasOwn(out, "__proto__")) {
      return { $knitting: "object", entries: Object.entries(out) };
    }
    return out;
  }
  return value;
};

const decodeUtf8 = (length: number): string => {
  // The host escapes non-ASCII code units. Copy that common case into one
  // bytestring allocation; retain UTF-8 decoding for other protocol clients.
  let ascii: i32 = 1;
  const pointer = inputPointer;
  Porffor.c`
for (i32 at = 0; at < (i32)length.val; at++) {
  if (((u8*)MEM)[(i32)pointer.val + at] >= 128) { ascii = 0; break; }
}
`;
  if (ascii !== 0) {
    const asciiText = " ".repeat(length);
    Porffor
      .c`memcpy(MEM + (i32)asciiText.val + 4, MEM + (i32)pointer.val, (i32)length.val);`;
    return asciiText;
  }
  // Porffor's `+=` copies the whole left operand, so appending to one growing
  // string is quadratic. Keep the appended string short and join once.
  const parts: string[] = [];
  let text = "";
  let index = 0;
  while (index < length) {
    if (text.length >= 1024) {
      parts.push(text);
      text = "";
    }
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
  if (parts.length === 0) return text;
  parts.push(text);
  return parts.join("");
};

const encodeUtf8 = (text: string): number => {
  const length = text.length;
  const pointer = outputPointer;
  const capacity = output.length;
  let result: i32 = 0;
  // JSON.stringify has already escaped lone surrogates. Read either of
  // Porffor's string layouts directly, retaining the existing UTF-8 framing.
  Porffor.c`
const u8* characters = (u8*)(MEM + (i32)text.val + 4);
u8* destination = (u8*)(MEM + (i32)pointer.val);
i32 stride = ((i32)text.type & 0x80) ? 1 : 2;
i32 used = 0;
for (i32 at = 0; at < (i32)length.val; at++) {
  u32 point = stride == 1 ? characters[at] : ((const u16*)characters)[at];
  if (point >= 0xd800 && point <= 0xdbff && at + 1 < (i32)length.val) {
    u32 low = stride == 1 ? characters[at + 1] : ((const u16*)characters)[at + 1];
    if (low >= 0xdc00 && low <= 0xdfff) {
      point = 0x10000 + ((point - 0xd800) << 10) + low - 0xdc00;
      at++;
    }
  }
  i32 count = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  if (used + count > (i32)capacity.val) { used = -1; break; }
  if (count == 1) {
    destination[used++] = point;
  } else if (count == 2) {
    destination[used++] = 0xc0 | (point >> 6);
    destination[used++] = 0x80 | (point & 0x3f);
  } else if (count == 3) {
    destination[used++] = 0xe0 | (point >> 12);
    destination[used++] = 0x80 | ((point >> 6) & 0x3f);
    destination[used++] = 0x80 | (point & 0x3f);
  } else {
    destination[used++] = 0xf0 | (point >> 18);
    destination[used++] = 0x80 | ((point >> 12) & 0x3f);
    destination[used++] = 0x80 | ((point >> 6) & 0x3f);
    destination[used++] = 0x80 | (point & 0x3f);
  }
}
result = used;
`;
  return result;
};

/** Common scalar JSON needs neither an intermediate string nor JSON.parse.
 * Escapes, non-ASCII strings, and containers use the general codec. */
const decodeRequest = (): unknown => {
  const length = requestLength();
  const pointer = inputPointer;
  let kind: i32 = 0;
  let numeric = 0;
  Porffor.c`
const u8* bytes = (u8*)(MEM + (i32)pointer.val);
i32 count = (i32)length.val;
if (count == 4 && memcmp(bytes, "null", 4) == 0) kind = 1;
else if (count == 5 && memcmp(bytes, "false", 5) == 0) kind = 2;
else if (count == 4 && memcmp(bytes, "true", 4) == 0) kind = 3;
else if (count >= 2 && bytes[0] == 34 && bytes[count - 1] == 34) {
  kind = 4;
  for (i32 at = 1; at < count - 1; at++) {
    u8 code = bytes[at];
    if (code < 32 || code >= 128 || code == 34 || code == 92) { kind = 0; break; }
  }
} else if (count > 0 && count <= 17) {
  i32 negative = bytes[0] == 45;
  i32 start = negative ? 1 : 0;
  i32 valid = start < count && !(bytes[start] == 48 && count - start > 1);
  f64 value = 0;
  for (i32 at = start; valid && at < count; at++) {
    if (bytes[at] < 48 || bytes[at] > 57) { valid = 0; break; }
    value = value * 10 + (bytes[at] - 48);
    if (value > 9007199254740991.0) valid = 0;
  }
  if (valid) { kind = 5; numeric = negative ? -value : value; }
}
/* Canonical JS numbers are short. Validate JSON grammar before strtod: its
   hexadecimal, infinity, whitespace, and partial-parse extensions are not JSON.
   This keeps conversion independent of Porffor's numeric JSON implementation. */
if (kind == 0 && count > 0 && count < 128
    && (bytes[0] == 45 || (bytes[0] >= 48 && bytes[0] <= 57))) {
  i32 at = bytes[0] == 45 ? 1 : 0;
  i32 valid = at < count;
  if (valid && bytes[at] == 48) at++;
  else if (valid && bytes[at] >= 49 && bytes[at] <= 57) {
    do { at++; } while (at < count && bytes[at] >= 48 && bytes[at] <= 57);
  } else valid = 0;
  if (valid && at < count && bytes[at] == 46) {
    i32 start = ++at;
    while (at < count && bytes[at] >= 48 && bytes[at] <= 57) at++;
    if (at == start) valid = 0;
  }
  if (valid && at < count && (bytes[at] == 69 || bytes[at] == 101)) {
    at++;
    if (at < count && (bytes[at] == 43 || bytes[at] == 45)) at++;
    i32 start = at;
    while (at < count && bytes[at] >= 48 && bytes[at] <= 57) at++;
    if (at == start) valid = 0;
  }
  if (valid && at == count) {
    char text[128];
    memcpy(text, bytes, count);
    text[count] = 0;
    numeric = strtod(text, (char**)0);
    kind = 5;
  }
}
`;
  if (kind === 1) return null;
  if (kind === 2) return false;
  if (kind === 3) return true;
  if (kind === 5) return numeric;
  if (kind === 4) {
    const text = " ".repeat(length - 2);
    Porffor.c`
memcpy(MEM + (i32)text.val + 4, MEM + (i32)pointer.val + 1, (i32)length.val - 2);
`;
    return text;
  }
  return decodeWireValue(JSON.parse(decodeUtf8(length)));
};

/** -2 requests the general JSON encoder; -1 means the response exceeds budget. */
const encodePlainString = (text: string): number => {
  const pointer = outputPointer;
  const capacity = output.length;
  let result: i32 = -2;
  Porffor.c`
const u8* characters = (u8*)(MEM + (i32)text.val + 4);
u8* destination = (u8*)(MEM + (i32)pointer.val);
i32 stride = ((i32)text.type & 0x80) ? 1 : 2;
i32 count = *(i32*)(MEM + (i32)text.val);
i32 plain = 1;
if (count > (i32)capacity.val - 2) { result = -1; plain = 0; }
for (i32 at = 0; plain && at < count; at++) {
  u32 code = stride == 1 ? characters[at] : ((const u16*)characters)[at];
  if (code < 32 || code >= 128 || code == 34 || code == 92) { plain = 0; break; }
}
if (plain) {
  destination[0] = 34;
  if (stride == 1) memcpy(destination + 1, characters, count);
  else for (i32 at = 0; at < count; at++) {
    destination[at + 1] = ((const u16*)characters)[at];
  }
  destination[count + 1] = 34;
  result = count + 2;
}
`;
  return result;
};

const encodeNumber = (value: number): number => {
  const pointer = outputPointer;
  let length: i32 = 0;
  // Seventeen significant digits round-trip every finite f64. The wire need
  // not use JSON.stringify's shortest spelling, but must preserve its value.
  Porffor.c`
char* destination = (char*)(MEM + (i32)pointer.val);
if (!isfinite(value.val)) { memcpy(destination, "null", 4); length = 4; }
else if (value.val == 0) { destination[0] = '0'; length = 1; }
else length = snprintf(destination, 32, "%.17g", (double)value.val);
`;
  return length;
};

const encodeLiteral = (text: string): number => {
  const pointer = outputPointer;
  let length: i32 = 0;
  Porffor.c`
length = *(i32*)(MEM + (i32)text.val);
memcpy(MEM + (i32)pointer.val, MEM + (i32)text.val + 4, length);
`;
  return length;
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
      const value = decodeRequest();
      const result = functions[taskIndex]!(value, abortSignal);
      let length = -2;
      if (typeof result === "string") length = encodePlainString(result);
      else if (typeof result === "number") length = encodeNumber(result);
      else if (result === null) length = encodeLiteral("null");
      else if (typeof result === "boolean") {
        length = encodeLiteral(result ? "true" : "false");
      }
      if (length === -2) {
        const serialized = JSON.stringify(encodeWireValue(result));
        if (typeof serialized !== "string") {
          if (writeResponse(2, outputPointer, 0) !== 0) return;
          continue;
        }
        length = encodeUtf8(serialized);
      }
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
