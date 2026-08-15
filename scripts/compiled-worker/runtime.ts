/// <reference path="./porffor.d.ts" />

type WorkerFunction = (value: unknown) => unknown;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const READ_EOF = -2147483648;
const input = new Uint8Array(MAX_PAYLOAD_BYTES);
const output = new Uint8Array(MAX_PAYLOAD_BYTES);

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

static i32 knit_json_read_request(i32 pointer, i32 capacity) {
  i32 header[2] = {0};
  if (knit_json_read_exact(header, (i32)sizeof(header)) != 1) {
    return (i32)0x80000000u;
  }
  i32 task_index = header[0];
  i32 length = header[1];
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
 * Requests and responses use an eight-byte little-endian header followed by
 * UTF-8 JSON. The header is i32 task/status plus i32 byte length.
 */
export const runJsonWorker = (functions: WorkerFunction[]): void => {
  while (true) {
    const taskIndex = readRequest(inputPointer, MAX_PAYLOAD_BYTES);
    if (taskIndex === READ_EOF || taskIndex === -1) return;
    if (taskIndex < 0 || taskIndex >= functions.length) {
      if (writeResponse(1, outputPointer, 0) !== 0) return;
      continue;
    }

    try {
      const value = JSON.parse(decodeUtf8(requestLength()));
      const result = functions[taskIndex]!(value);
      const serialized = JSON.stringify(result);
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
