// src/common/runtime.ts
var globals = globalThis;
var IS_DENO = typeof globals.Deno?.version?.deno === "string";
var IS_BUN = typeof globals.Bun?.version === "string";
var IS_NODE = typeof process !== "undefined" && typeof process.versions?.node === "string";
var IS_BROWSER = !IS_DENO && !IS_BUN && !IS_NODE && (typeof globals.document !== "undefined" || typeof globals.navigator !== "undefined" || typeof globals.WorkerGlobalScope === "function");
var RUNTIME = IS_DENO ? "deno" : IS_BUN ? "bun" : IS_NODE ? "node" : "unknown";
var SET_IMMEDIATE = typeof globals.setImmediate === "function" ? globals.setImmediate : undefined;
var WASM_MEMORY_PAGE_BYTES = 64 * 1024;
var wasmSharedBufferMemory = new WeakMap;
var wasmSharedBufferMaxByteLength = new WeakMap;
var hasSharedWasmMemory = (() => {
  if (typeof WebAssembly?.Memory !== "function")
    return false;
  try {
    new WebAssembly.Memory({ initial: 0, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
})();
var roundupWasmPages = (byteLength) => Math.ceil(Math.max(0, byteLength) / WASM_MEMORY_PAGE_BYTES);
var createSharedWasmBuffer = (byteLength, maxByteLength) => {
  const memory = new WebAssembly.Memory({
    initial: roundupWasmPages(byteLength),
    maximum: Math.max(roundupWasmPages(byteLength), roundupWasmPages(maxByteLength)),
    shared: true
  });
  const buffer = memory.buffer;
  wasmSharedBufferMemory.set(buffer, memory);
  wasmSharedBufferMaxByteLength.set(buffer, maxByteLength);
  return buffer;
};
var createWasmSharedArrayBuffer = (byteLength, maxByteLength = byteLength) => {
  if (hasSharedWasmMemory) {
    return createSharedWasmBuffer(byteLength, maxByteLength);
  }
  return new SharedArrayBuffer(byteLength);
};
var HAS_NATIVE_SAB_GROW = typeof SharedArrayBuffer === "function" && typeof SharedArrayBuffer.prototype.grow === "function";
var HAS_SAB_GROW = HAS_NATIVE_SAB_GROW || hasSharedWasmMemory;
var createSharedArrayBuffer = (byteLength, maxByteLength) => {
  if (HAS_NATIVE_SAB_GROW && typeof maxByteLength === "number") {
    return new SharedArrayBuffer(byteLength, { maxByteLength });
  }
  if (hasSharedWasmMemory && typeof maxByteLength === "number") {
    return createSharedWasmBuffer(byteLength, maxByteLength);
  }
  return new SharedArrayBuffer(byteLength);
};
var isGrowableSharedArrayBuffer = (sab) => {
  const value = sab;
  return HAS_NATIVE_SAB_GROW && typeof value.grow === "function" && value.growable === true || wasmSharedBufferMemory.has(sab);
};
var sharedArrayBufferMaxByteLength = (sab) => {
  const value = sab;
  if (typeof value.maxByteLength === "number") {
    return value.maxByteLength;
  }
  return wasmSharedBufferMaxByteLength.get(sab) ?? sab.byteLength;
};
var growSharedArrayBuffer = (sab, byteLength) => {
  const native = sab;
  if (typeof native.grow === "function") {
    native.grow(byteLength);
    return sab;
  }
  const memory = wasmSharedBufferMemory.get(sab);
  if (memory == null) {
    throw new TypeError("SharedArrayBuffer is not growable");
  }
  const currentBuffer = memory.buffer;
  if (currentBuffer.byteLength >= byteLength) {
    return currentBuffer;
  }
  const targetPages = roundupWasmPages(byteLength);
  const currentPages = roundupWasmPages(currentBuffer.byteLength);
  memory.grow(targetPages - currentPages);
  const nextBuffer = memory.buffer;
  const maxByteLength = wasmSharedBufferMaxByteLength.get(sab) ?? currentBuffer.byteLength;
  wasmSharedBufferMemory.set(nextBuffer, memory);
  wasmSharedBufferMaxByteLength.set(nextBuffer, maxByteLength);
  return nextBuffer;
};

// src/common/node-compat.ts
var hiddenImport = Function("specifier", "return import(specifier);");
var importNodeModule = async (specifier) => {
  if (!IS_NODE)
    return;
  try {
    return await hiddenImport(specifier);
  } catch {
    return;
  }
};
var rawPathModule = await importNodeModule("node:path");
var rawFsModule = await importNodeModule("node:fs");
var rawUrlModule = await importNodeModule("node:url");
var pathModule = rawPathModule?.default ?? rawPathModule;
var WINDOWS_DRIVE_PATH = /^[A-Za-z]:[/\\]/;
var WINDOWS_UNC_PATH = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/;
var hostIsWindows = (() => {
  try {
    if (typeof process !== "undefined")
      return process.platform === "win32";
  } catch {}
  const g = globalThis;
  return g.Deno?.build?.os === "windows";
})();
var looksWindowsPath = (value) => hostIsWindows || WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
var normalizePathSeparators = (value) => value.replace(/\\/g, "/");
var splitRoot = (value) => {
  const normalized = normalizePathSeparators(value);
  if (WINDOWS_UNC_PATH.test(value)) {
    const [, host = "", share = "", rest = ""] = normalized.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/) ?? [];
    return {
      root: `//${host}/${share}`,
      rest: rest.replace(/^\/+/, "")
    };
  }
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return {
      root: normalized.slice(0, 2).toUpperCase() + "/",
      rest: normalized.slice(3)
    };
  }
  if (normalized.startsWith("/")) {
    return {
      root: "/",
      rest: normalized.replace(/^\/+/, "")
    };
  }
  return {
    root: "",
    rest: normalized
  };
};
var normalizeJoinedPath = (value) => {
  const { root, rest } = splitRoot(value);
  const parts = rest.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".")
      continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!root) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  if (root) {
    const joined = stack.join("/");
    return joined.length > 0 ? `${root}${joined}` : root;
  }
  return stack.length > 0 ? stack.join("/") : ".";
};
var fallbackIsAbsolute = (value) => {
  if (value.length === 0)
    return false;
  const normalized = normalizePathSeparators(value);
  return normalized.startsWith("/") || WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
};
var fallbackResolve = (...segments) => {
  let resolved = "";
  for (let i = segments.length - 1;i >= 0; i--) {
    const segment = segments[i];
    if (!segment)
      continue;
    resolved = resolved ? `${segment}/${resolved}` : segment;
    if (fallbackIsAbsolute(segment))
      break;
  }
  if (!fallbackIsAbsolute(resolved)) {
    resolved = `/${resolved}`;
  }
  return normalizeJoinedPath(resolved);
};
var fallbackJoin = (...segments) => normalizeJoinedPath(segments.filter(Boolean).join("/"));
var fallbackDirname = (value) => {
  const normalized = normalizeJoinedPath(value);
  const { root, rest } = splitRoot(normalized);
  if (!rest)
    return root || ".";
  const parts = rest.split("/");
  parts.pop();
  if (root) {
    return parts.length > 0 ? `${root}${parts.join("/")}` : root;
  }
  return parts.length > 0 ? parts.join("/") : ".";
};
var fallbackBasename = (value) => {
  const normalized = normalizeJoinedPath(value);
  const { rest } = splitRoot(normalized);
  const parts = rest.split("/");
  return parts[parts.length - 1] ?? "";
};
var splitRelativeParts = (value) => {
  const normalized = normalizeJoinedPath(value);
  const { rest } = splitRoot(normalized);
  if (!rest)
    return [];
  return rest.split("/").filter(Boolean);
};
var fallbackRelative = (from, to) => {
  const fromResolved = fallbackResolve(from);
  const toResolved = fallbackResolve(to);
  const fromRoot = splitRoot(fromResolved).root;
  const toRoot = splitRoot(toResolved).root;
  if (fromRoot !== toRoot)
    return toResolved;
  const fromParts = splitRelativeParts(fromResolved);
  const toParts = splitRelativeParts(toResolved);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const up = new Array(fromParts.length - common).fill("..");
  const down = toParts.slice(common);
  const out = [...up, ...down].join("/");
  return out.length > 0 ? out : "";
};
var encodeFilePath = (value) => encodeURI(value).replace(/\?/g, "%3F").replace(/#/g, "%23");
var fallbackFileURLToPath = (value) => {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "file:") {
    throw new TypeError("Expected a file URL");
  }
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname))
    pathname = pathname.slice(1);
  if (url.host.length > 0) {
    return `//${url.host}${pathname}`;
  }
  return looksWindowsPath(pathname) ? pathname.replace(/\//g, "\\") : pathname;
};
var fallbackPathToFileURL = (value) => {
  if (WINDOWS_UNC_PATH.test(value)) {
    const normalized2 = normalizePathSeparators(value).replace(/^\/+/, "");
    return new URL(`file://${encodeFilePath(normalized2)}`);
  }
  if (WINDOWS_DRIVE_PATH.test(value)) {
    const normalized2 = normalizePathSeparators(value);
    return new URL(`file:///${encodeFilePath(normalized2)}`);
  }
  const absolute = fallbackIsAbsolute(value) ? value : fallbackResolve(value);
  const normalized = normalizePathSeparators(absolute);
  return new URL(`file://${encodeFilePath(normalized.startsWith("/") ? normalized : `/${normalized}`)}`);
};
var pathResolve = pathModule?.resolve?.bind(pathModule) ?? fallbackResolve;
var pathJoin = pathModule?.join?.bind(pathModule) ?? fallbackJoin;
var pathDirname = pathModule?.dirname?.bind(pathModule) ?? fallbackDirname;
var pathBasename = pathModule?.basename?.bind(pathModule) ?? fallbackBasename;
var pathRelative = pathModule?.relative?.bind(pathModule) ?? fallbackRelative;
var pathIsAbsolute = pathModule?.isAbsolute?.bind(pathModule) ?? fallbackIsAbsolute;
var fileURLToPathCompat = rawUrlModule?.fileURLToPath ?? fallbackFileURLToPath;
var pathToFileURLCompat = rawUrlModule?.pathToFileURL ?? fallbackPathToFileURL;
var existsSyncCompat = rawFsModule?.existsSync;
var realpathSyncCompat = rawFsModule?.realpathSync?.native ?? rawFsModule?.realpathSync;

// src/common/worker-runtime.ts
var workerThreads = await importNodeModule("node:worker_threads");
var isWebWorkerScope = () => {
  const scopeCtor = globalThis.WorkerGlobalScope;
  if (typeof scopeCtor !== "function")
    return false;
  try {
    return globalThis instanceof scopeCtor;
  } catch {
    return false;
  }
};
var RUNTIME_WORKER = workerThreads?.Worker ?? globalThis.Worker;
var RUNTIME_MESSAGE_CHANNEL = workerThreads?.MessageChannel ?? globalThis.MessageChannel;
var HAS_NODE_WORKER_THREADS = workerThreads != null;
var RUNTIME_IS_MAIN_THREAD = workerThreads?.isMainThread ?? !isWebWorkerScope();
var RUNTIME_WORKER_DATA = workerThreads?.workerData;
var RUNTIME_PARENT_PORT = workerThreads?.parentPort ?? undefined;
var createRuntimeMessageChannel = () => {
  if (typeof RUNTIME_MESSAGE_CHANNEL !== "function") {
    throw new Error("MessageChannel is not available in this runtime");
  }
  return new RUNTIME_MESSAGE_CHANNEL;
};

// src/common/shared-buffer-region.ts
var isSharedBufferRegion = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return candidate.sab instanceof SharedArrayBuffer && typeof candidate.byteOffset === "number" && Number.isInteger(candidate.byteOffset) && candidate.byteOffset >= 0 && typeof candidate.byteLength === "number" && Number.isInteger(candidate.byteLength) && candidate.byteLength >= 0;
};
var isSharedBufferSource = (value) => value instanceof SharedArrayBuffer || isSharedBufferRegion(value);
var toSharedBufferRegion = (value) => value instanceof SharedArrayBuffer ? {
  sab: value,
  byteOffset: 0,
  byteLength: value.byteLength
} : value;

// src/common/shared-buffer-text.ts
var textEncode = new TextEncoder;
var textDecode = new TextDecoder;
var isSharedBufferTextCompatTypeError = (error) => error instanceof TypeError;
var makeProbeView = (source) => {
  const region = toSharedBufferRegion(source);
  const probeLength = Math.min(1, region.byteLength);
  return new Uint8Array(region.sab, region.byteOffset, probeLength);
};
var isSharedBufferTextCompat = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return typeof candidate.encodeInto === "boolean" && typeof candidate.decode === "boolean";
};
var isLockBufferTextCompat = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return isSharedBufferTextCompat(candidate.headers) && isSharedBufferTextCompat(candidate.payload);
};
var probeSharedBufferTextCompat = (source) => {
  const view = makeProbeView(source);
  const encodeInto = (() => {
    if (typeof textEncode.encodeInto !== "function")
      return false;
    const probe = view.byteLength > 0 ? view : view.subarray(0, 0);
    const restoredByte = probe.byteLength > 0 ? probe[0] : undefined;
    try {
      textEncode.encodeInto(probe.byteLength > 0 ? "a" : "", probe);
      return true;
    } catch (error) {
      if (!isSharedBufferTextCompatTypeError(error))
        throw error;
      return false;
    } finally {
      if (restoredByte !== undefined) {
        probe[0] = restoredByte;
      }
    }
  })();
  const decode = (() => {
    try {
      textDecode.decode(view);
      return true;
    } catch (error) {
      if (!isSharedBufferTextCompatTypeError(error))
        throw error;
      return false;
    }
  })();
  return {
    encodeInto,
    decode
  };
};
var probeLockBufferTextCompat = ({
  headers,
  payload
}) => ({
  headers: probeSharedBufferTextCompat(headers),
  payload: probeSharedBufferTextCompat(payload)
});

// src/ipc/tools/RingQueue.ts
class RingQueue {
  #buf;
  #mask;
  #head = 0;
  #tail = 0;
  #size = 0;
  constructor(capacity = 512) {
    let cap = 2;
    while (cap < capacity)
      cap <<= 1;
    this.#buf = new Array(cap).fill(null);
    this.#mask = cap - 1;
  }
  get size() {
    return this.#size;
  }
  get isEmpty() {
    return this.#size === 0;
  }
  get capacity() {
    return this.#mask + 1;
  }
  clear() {
    this.#head = 0;
    this.#tail = 0;
    this.#size = 0;
  }
  peek() {
    return this.#size === 0 ? undefined : this.#buf[this.#head];
  }
  reserve(minCapacity) {
    if (minCapacity <= this.capacity)
      return;
    let cap = this.capacity;
    while (cap < minCapacity)
      cap <<= 1;
    this.#growTo(cap);
  }
  #growIfFull() {
    if (this.#size !== this.#mask + 1)
      return;
    this.#growTo(this.#mask + 1 << 1);
  }
  #growTo(newCap) {
    const oldBuf = this.#buf;
    const oldCap = this.#mask + 1;
    const n = this.#size;
    const next = new Array(newCap).fill(null);
    const head = this.#head;
    const firstLen = Math.min(n, oldCap - head);
    for (let i = 0;i < firstLen; i++) {
      next[i] = oldBuf[head + i];
    }
    for (let i = firstLen;i < n; i++) {
      next[i] = oldBuf[i - firstLen];
    }
    this.#buf = next;
    this.#mask = newCap - 1;
    this.#head = 0;
    this.#tail = n;
  }
  push(value) {
    this.#growIfFull();
    const buf = this.#buf;
    const mask = this.#mask;
    const tail = this.#tail;
    buf[tail] = value;
    this.#tail = tail + 1 & mask;
    this.#size++;
    return true;
  }
  unshift(value) {
    this.#growIfFull();
    const buf = this.#buf;
    const mask = this.#mask;
    const head = this.#head - 1 & mask;
    this.#head = head;
    buf[head] = value;
    this.#size++;
    return true;
  }
  shift() {
    const size = this.#size;
    if (size === 0)
      return;
    const head = this.#head;
    const buf = this.#buf;
    const v = buf[head];
    buf[head] = null;
    this.#head = head + 1 & this.#mask;
    this.#size = size - 1;
    return v;
  }
  shiftNoClear() {
    const size = this.#size;
    if (size === 0)
      return;
    const head = this.#head;
    const v = this.#buf[head];
    this.#head = head + 1 & this.#mask;
    this.#size = size - 1;
    return v;
  }
  *[Symbol.iterator]() {
    const buf = this.#buf;
    const mask = this.#mask;
    let idx = this.#head;
    let i = 0;
    const n = this.#size;
    while (i < n) {
      const v = buf[idx];
      if (v !== null)
        yield v;
      idx = idx + 1 & mask;
      i++;
    }
  }
  toArray() {
    const out = new Array(this.#size);
    const buf = this.#buf;
    const mask = this.#mask;
    let idx = this.#head;
    for (let i = 0;i < out.length; i++) {
      out[i] = buf[idx];
      idx = idx + 1 & mask;
    }
    return out;
  }
  get [Symbol.toStringTag]() {
    return `RingQueue(size=${this.#size}, cap=${this.capacity})`;
  }
}

// src/memory/regionRegistry.ts
var SLOT_META_PACKED_MASK = 4294967264;
var register = ({ lockSector }) => {
  const lockRegion = toSharedBufferRegion(lockSector ?? createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH));
  const lockSAB = lockRegion.sab;
  const hostBits = new Int32Array(lockSAB, lockRegion.byteOffset + PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES, 1);
  const workerBits = new Int32Array(lockSAB, lockRegion.byteOffset + PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES, 1);
  const startAndIndex = new Uint32Array(32 /* slots */);
  const size64bit = new Uint32Array(32 /* slots */);
  const clz32 = Math.clz32;
  const EMPTY = 4294967295 >>> 0;
  const SLOT_MASK = TASK_SLOT_INDEX_MASK;
  const START_MASK = ~SLOT_MASK >>> 0;
  startAndIndex.fill(EMPTY);
  let tableLength = 0;
  let usedBits = 0 | 0;
  let hostLast = 0 | 0;
  let workerLast = 0 | 0;
  const startAndIndexToArray = (length) => startAndIndex.slice(0, length);
  const compactFreeBitsStable = (b, freeBits) => {
    const sai = startAndIndex;
    let w = 0 | 0;
    b = b | 0;
    freeBits = freeBits >>> 0;
    for (let r = 0;r < b; r++) {
      const v = sai[r];
      if (v === EMPTY)
        continue;
      if ((freeBits & 1 << (v & SLOT_MASK)) !== 0)
        continue;
      if (w !== r)
        sai[w] = v;
      w++;
    }
    const live = w;
    for (;w < b; w++)
      sai[w] = EMPTY;
    return live;
  };
  const updateTable = () => {
    const w = Atomics.load(workerBits, 0) | 0;
    const state = (hostLast ^ w) >>> 0;
    let freeBits = ~state >>> 0;
    if (tableLength === 0 || freeBits === 0)
      return;
    if (freeBits === EMPTY) {
      tableLength = 0;
      usedBits = 0 | 0;
      return;
    }
    freeBits &= usedBits;
    if (freeBits === 0)
      return;
    usedBits &= ~freeBits;
    tableLength = compactFreeBitsStable(tableLength, freeBits);
  };
  const findAndInsert = (task, size) => {
    const sai = startAndIndex;
    const sz = size64bit;
    let tl = tableLength;
    let insertAt = -1;
    let insertStart = 0;
    let prevEnd = 0;
    let didCompactScan = false;
    if (tl === 0 && usedBits === 0) {
      sai[0] = 0;
      sz[0] = size;
      task[3 /* Start */] = 0;
      task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | 0) >>> 0;
      tableLength = 1;
      usedBits = 1;
      hostLast ^= 1;
      return 0;
    }
    if (tl !== 0) {
      const w = Atomics.load(workerBits, 0) | 0;
      let freeBits = ~(hostLast ^ w) >>> 0;
      if (freeBits !== 0)
        freeBits &= usedBits;
      if (freeBits === EMPTY) {
        tableLength = 0;
        usedBits = 0 | 0;
        tl = 0;
      } else if (freeBits !== 0) {
        for (let i = 0;i < tl; i++) {
          const v = sai[i];
          const reclaimedSlot = v & SLOT_MASK;
          const reclaimedBit = 1 << reclaimedSlot;
          if ((freeBits & reclaimedBit) === 0)
            continue;
          if (sz[reclaimedSlot] >>> 0 !== size >>> 0)
            continue;
          const availableBits2 = ~usedBits >>> 0;
          const freeBit2 = (availableBits2 & -availableBits2) >>> 0;
          if (freeBit2 === 0)
            return -1;
          const slotIndex2 = 31 - clz32(freeBit2);
          const start = v & START_MASK;
          sai[i] = (start | slotIndex2) >>> 0;
          sz[slotIndex2] = size;
          task[3 /* Start */] = start;
          task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex2) >>> 0;
          usedBits = usedBits & ~reclaimedBit | freeBit2;
          hostLast ^= freeBit2;
          return slotIndex2;
        }
      }
      if (tl !== 0 && freeBits !== 0 && freeBits !== EMPTY) {
        didCompactScan = true;
        let write = 0;
        for (let read = 0;read < tl; read++) {
          const v = sai[read];
          const slot = v & SLOT_MASK;
          if ((freeBits & 1 << slot) !== 0)
            continue;
          const curStart = v & START_MASK;
          if (insertAt === -1 && curStart - prevEnd >>> 0 >= size >>> 0) {
            insertAt = write;
            insertStart = prevEnd;
          }
          if (write !== read)
            sai[write] = v;
          write++;
          prevEnd = curStart + (sz[slot] >>> 0) >>> 0;
        }
        for (let i = write;i < tl; i++)
          sai[i] = EMPTY;
        if (freeBits !== 0)
          usedBits &= ~freeBits;
        tableLength = tl = write;
      }
    }
    if (tl >= 32 /* slots */)
      return -1;
    const availableBits = ~usedBits >>> 0;
    const freeBit = (availableBits & -availableBits) >>> 0;
    if (freeBit === 0)
      return -1;
    const slotIndex = 31 - clz32(freeBit);
    if (!didCompactScan && tl !== 0) {
      const firstStart = sai[0] & START_MASK;
      if (firstStart >= size >>> 0) {
        for (let i = tl;i > 0; i--)
          sai[i] = sai[i - 1];
        sai[0] = slotIndex;
        sz[slotIndex] = size;
        task[3 /* Start */] = 0;
        task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
        tableLength = tl + 1;
        usedBits |= freeBit;
        hostLast ^= freeBit;
        return slotIndex;
      }
      for (let at = 0;at + 1 < tl; at++) {
        const cur = sai[at];
        const curStart = cur & START_MASK;
        const curEnd = curStart + (sz[cur & SLOT_MASK] >>> 0) >>> 0;
        const nextStart = sai[at + 1] & START_MASK;
        if (nextStart - curEnd >>> 0 < size >>> 0)
          continue;
        for (let i = tl;i > at + 1; i--)
          sai[i] = sai[i - 1];
        sai[at + 1] = (curEnd | slotIndex) >>> 0;
        sz[slotIndex] = size;
        task[3 /* Start */] = curEnd;
        task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
        tableLength = tl + 1;
        usedBits |= freeBit;
        hostLast ^= freeBit;
        return slotIndex;
      }
      const last = sai[tl - 1];
      const lastStart = last & START_MASK;
      const newStart = lastStart + (sz[last & SLOT_MASK] >>> 0) >>> 0;
      sai[tl] = (newStart | slotIndex) >>> 0;
      sz[slotIndex] = size;
      task[3 /* Start */] = newStart;
      task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }
    if (tl === 0) {
      sai[0] = slotIndex;
      sz[slotIndex] = size;
      task[3 /* Start */] = 0;
      task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
      tableLength = 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }
    if (insertAt !== -1) {
      for (let i = tl;i > insertAt; i--)
        sai[i] = sai[i - 1];
      sai[insertAt] = (insertStart | slotIndex) >>> 0;
      sz[slotIndex] = size;
      task[3 /* Start */] = insertStart;
      task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
      tableLength = tl + 1;
      usedBits |= freeBit;
      hostLast ^= freeBit;
      return slotIndex;
    }
    sai[tl] = (prevEnd | slotIndex) >>> 0;
    sz[slotIndex] = size;
    task[3 /* Start */] = prevEnd;
    task[6 /* slotBuffer */] = (task[6 /* slotBuffer */] & SLOT_META_PACKED_MASK | slotIndex) >>> 0;
    tableLength = tl + 1;
    usedBits |= freeBit;
    hostLast ^= freeBit;
    return slotIndex;
  };
  const allocTask = (task) => {
    const payloadLen = task[5 /* PayloadLen */] | 0;
    const size = payloadLen + 63 & ~63;
    const slotIndex = findAndInsert(task, size);
    hostBits[0] = hostLast;
    return slotIndex;
  };
  const setSlotLength = (slotIndex, payloadLen) => {
    slotIndex = slotIndex & TASK_SLOT_INDEX_MASK;
    const aligned = (payloadLen | 0) + 63 & ~63;
    size64bit[slotIndex] = aligned >>> 0;
    return true;
  };
  const free = (index) => {
    index = index & TASK_SLOT_INDEX_MASK;
    workerLast ^= 1 << index;
    Atomics.store(workerBits, 0, workerLast);
  };
  return {
    allocTask,
    setSlotLength,
    lockSAB,
    free,
    hostBits,
    workerBits,
    updateTable,
    startAndIndexToArray
  };
};

// src/memory/byte-carpet.ts
var BYTE_CARPET_ALIGN_BYTES = 64;
var U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
var toNonNegativeInteger = (value, label) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
};
var alignBytes = (value, alignment = BYTE_CARPET_ALIGN_BYTES) => {
  const safeValue = toNonNegativeInteger(value, "value");
  const safeAlignment = toNonNegativeInteger(alignment, "alignment");
  if (safeAlignment === 0) {
    throw new RangeError("alignment must be greater than zero");
  }
  return Math.ceil(safeValue / safeAlignment) * safeAlignment;
};
var makeSharedBufferRegion = (sab, byteOffset, byteLength) => ({
  sab,
  byteOffset: toNonNegativeInteger(byteOffset, "byteOffset"),
  byteLength: toNonNegativeInteger(byteLength, "byteLength")
});
var createByteCarpet = ({
  alignTo = BYTE_CARPET_ALIGN_BYTES,
  startByteOffset = 0
} = {}) => {
  const defaultAlignment = toNonNegativeInteger(alignTo, "alignTo");
  if (defaultAlignment === 0) {
    throw new RangeError("alignTo must be greater than zero");
  }
  let cursor = toNonNegativeInteger(startByteOffset, "startByteOffset");
  const slices = [];
  const take = (name, byteLength, {
    alignTo: sliceAlignment = defaultAlignment,
    reserveByteLength
  } = {}) => {
    const logicalByteLength = toNonNegativeInteger(byteLength, `${name} byteLength`);
    const safeSliceAlignment = toNonNegativeInteger(sliceAlignment, `${name} alignTo`);
    if (safeSliceAlignment === 0) {
      throw new RangeError(`${name} alignTo must be greater than zero`);
    }
    const reserved = reserveByteLength == null ? alignBytes(logicalByteLength, safeSliceAlignment) : toNonNegativeInteger(reserveByteLength, `${name} reserveByteLength`);
    if (reserved < logicalByteLength) {
      throw new RangeError(`${name} reserveByteLength must cover byteLength`);
    }
    const byteOffset = alignBytes(cursor, safeSliceAlignment);
    const slice = {
      name,
      byteOffset,
      byteLength: logicalByteLength,
      reservedByteLength: reserved
    };
    slices.push(slice);
    cursor = byteOffset + reserved;
    return slice;
  };
  return {
    slices,
    take,
    byteLength: () => cursor,
    bind: (sab, slice) => makeSharedBufferRegion(sab, slice.byteOffset, slice.byteLength)
  };
};
var getStridedSlotOffsetU32 = ({
  slotIndex,
  slotStrideU32,
  baseU32 = 0,
  extraU32 = 0
}) => slotIndex * slotStrideU32 + baseU32 + extraU32;
var getStridedSlotByteOffset = ({
  slotIndex,
  slotStrideU32,
  baseByteOffset = 0,
  baseU32 = 0,
  extraU32 = 0
}) => baseByteOffset + getStridedSlotOffsetU32({
  slotIndex,
  slotStrideU32,
  baseU32,
  extraU32
}) * U32_BYTES;
var getStridedRegionSpanBytes = ({
  slotCount,
  slotStrideU32,
  slotLengthU32,
  baseU32 = 0
}) => {
  const safeSlotCount = toNonNegativeInteger(slotCount, "slotCount");
  if (safeSlotCount === 0)
    return 0;
  return (getStridedSlotOffsetU32({
    slotIndex: safeSlotCount - 1,
    slotStrideU32,
    baseU32
  }) + slotLengthU32) * U32_BYTES;
};
var getInterleavedSlotStrideU32 = (slotStrideU32) => slotStrideU32 * 2;
var getHeaderBlockByteLength = ({
  slotCount,
  slotStrideU32,
  queues = 1,
  alignTo = BYTE_CARPET_ALIGN_BYTES
}) => alignBytes(slotCount * slotStrideU32 * U32_BYTES * queues, alignTo);
var createInterleavedHeaderPair = ({
  sab,
  byteOffset,
  slotCount,
  slotStrideU32
}) => {
  const headerSlotStrideU32 = getInterleavedSlotStrideU32(slotStrideU32);
  const slotBytes = slotStrideU32 * U32_BYTES;
  const spanBytes = getStridedRegionSpanBytes({
    slotCount,
    slotStrideU32: headerSlotStrideU32,
    slotLengthU32: slotStrideU32
  });
  return {
    headerSlotStrideU32,
    requestHeaders: makeSharedBufferRegion(sab, byteOffset, spanBytes),
    returnHeaders: makeSharedBufferRegion(sab, byteOffset + slotBytes, spanBytes)
  };
};
var createLockControlCarpet = ({
  signalBytes,
  abortBytes,
  lockSectorBytes,
  headerSlotStrideU32,
  slotCount,
  headerLayout = "interleaved",
  alignTo = BYTE_CARPET_ALIGN_BYTES,
  createBuffer = (byteLength) => new SharedArrayBuffer(byteLength)
}) => {
  const carpet = createByteCarpet({ alignTo });
  const signalsSlice = carpet.take("signals", signalBytes);
  const requestLockSlice = carpet.take("requestLockSector", lockSectorBytes);
  const returnLockSlice = carpet.take("returnLockSector", lockSectorBytes);
  let requestHeadersSlice;
  let returnHeadersSlice;
  let interleavedHeadersSlice;
  if (headerLayout === "interleaved") {
    interleavedHeadersSlice = carpet.take("interleavedHeaders", getHeaderBlockByteLength({
      slotCount,
      slotStrideU32: headerSlotStrideU32,
      queues: 2,
      alignTo
    }));
  } else {
    requestHeadersSlice = carpet.take("requestHeaders", getHeaderBlockByteLength({
      slotCount,
      slotStrideU32: headerSlotStrideU32,
      alignTo
    }));
    returnHeadersSlice = carpet.take("returnHeaders", getHeaderBlockByteLength({
      slotCount,
      slotStrideU32: headerSlotStrideU32,
      alignTo
    }));
  }
  const abortSignalsSlice = carpet.take("abortSignals", abortBytes);
  const controlSAB = createBuffer(carpet.byteLength());
  const signals = carpet.bind(controlSAB, signalsSlice);
  const abortSignals = carpet.bind(controlSAB, abortSignalsSlice);
  const requestLockSector = carpet.bind(controlSAB, requestLockSlice);
  const returnLockSector = carpet.bind(controlSAB, returnLockSlice);
  const headerPair = headerLayout === "interleaved" ? createInterleavedHeaderPair({
    sab: controlSAB,
    byteOffset: interleavedHeadersSlice.byteOffset,
    slotCount,
    slotStrideU32: headerSlotStrideU32
  }) : {
    headerSlotStrideU32,
    requestHeaders: carpet.bind(controlSAB, requestHeadersSlice),
    returnHeaders: carpet.bind(controlSAB, returnHeadersSlice)
  };
  return {
    controlSAB,
    signals,
    abortSignals,
    lock: {
      headers: headerPair.requestHeaders,
      headerSlotStrideU32: headerPair.headerSlotStrideU32,
      lockSector: requestLockSector,
      payloadSector: requestLockSector
    },
    returnLock: {
      headers: headerPair.returnHeaders,
      headerSlotStrideU32: headerPair.headerSlotStrideU32,
      lockSector: returnLockSector,
      payloadSector: returnLockSector
    },
    slices: carpet.slices
  };
};

// src/memory/payload-config.ts
var PAYLOAD_DEFAULT_MAX_BYTE_LENGTH = 64 * 1024 * 1024;
var PAYLOAD_DEFAULT_INITIAL_BYTES = 4 * 1024 * 1024;
var toPositiveInteger = (value) => {
  if (!Number.isFinite(value))
    return;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
};
var canGrowSharedBuffer = (sab) => {
  if (sab == null)
    return false;
  return HAS_SAB_GROW && isGrowableSharedArrayBuffer(sab);
};
var sharedBufferMaxByteLength = (sab) => {
  if (sab == null)
    return;
  return toPositiveInteger(sharedArrayBufferMaxByteLength(sab));
};
var resolvePayloadBufferOptions = ({
  options,
  sab
}) => {
  const requestedMode = options?.mode;
  const modeDefault = HAS_SAB_GROW ? "growable" : "fixed";
  let mode = requestedMode ?? modeDefault;
  if (mode === "growable" && sab != null && !canGrowSharedBuffer(sab)) {
    mode = "fixed";
  }
  if (mode === "growable" && !HAS_SAB_GROW) {
    mode = "fixed";
  }
  const payloadMaxByteLength = toPositiveInteger(options?.payloadMaxByteLength) ?? sharedBufferMaxByteLength(sab) ?? PAYLOAD_DEFAULT_MAX_BYTE_LENGTH;
  const requestedInitialBytes = toPositiveInteger(options?.payloadInitialBytes);
  const payloadInitialBytes = mode === "fixed" ? payloadMaxByteLength : Math.min(requestedInitialBytes ?? PAYLOAD_DEFAULT_INITIAL_BYTES, payloadMaxByteLength);
  const maxPayloadCeiling = payloadMaxByteLength >> 3;
  if (maxPayloadCeiling <= 0) {
    throw new RangeError("payloadMaxByteLength is too small; must be at least 8 bytes.");
  }
  const rawMaxPayloadBytes = options?.maxPayloadBytes;
  if (rawMaxPayloadBytes !== undefined) {
    const normalized = Math.floor(rawMaxPayloadBytes);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new RangeError(`maxPayloadBytes must be > 0 and <= ${maxPayloadCeiling}.`);
    }
  }
  const maxPayloadBytes = toPositiveInteger(rawMaxPayloadBytes) ?? maxPayloadCeiling;
  if (maxPayloadBytes <= 0 || maxPayloadBytes > maxPayloadCeiling) {
    throw new RangeError(`maxPayloadBytes must be > 0 and <= ${maxPayloadCeiling}.`);
  }
  return {
    mode,
    payloadInitialBytes,
    payloadMaxByteLength,
    maxPayloadBytes
  };
};

// src/memory/createSharedBufferIO.ts
var page = 1024 * 4;
var textEncode2 = new TextEncoder;
var textDecode2 = new TextDecoder;
var DYNAMIC_HEADER_BYTES = 64;
var DYNAMIC_SAFE_PADDING_BYTES = page;
var alignUpto64 = (n) => n + (64 - 1) & ~(64 - 1);
var isExactUint8Array = (src) => src.constructor === Uint8Array;
var canonicalDynamicUint8Array = (src) => isExactUint8Array(src) ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
var isSharedBufferEncodeIntoError = (error) => error instanceof TypeError;
var isSharedBufferDecodeError = (error) => error instanceof TypeError;
var getBufferCtor = () => {
  const bufferCtor = globalThis.Buffer;
  if (typeof bufferCtor?.from !== "function" || typeof bufferCtor?.allocUnsafe !== "function" || typeof bufferCtor?.allocUnsafeSlow !== "function") {
    return;
  }
  return bufferCtor;
};
var manualEncodeInto = (str, target) => {
  let read = 0;
  let written = 0;
  for (const char of str) {
    const encoded = textEncode2.encode(char);
    if (written + encoded.byteLength > target.byteLength)
      break;
    target.set(encoded, written);
    written += encoded.byteLength;
    read += char.length;
  }
  return { read, written };
};
var fallbackEncodeInto = (str, target) => {
  const scratch = new Uint8Array(target.byteLength);
  const result = typeof textEncode2.encodeInto === "function" ? textEncode2.encodeInto(str, scratch) : manualEncodeInto(str, scratch);
  if (result.written > 0) {
    target.set(scratch.subarray(0, result.written), 0);
  }
  return result;
};
var fallbackDecode = (bytes) => textDecode2.decode(bytes.slice());
var browserEncodeInto = (str, target, textCompat) => {
  if (typeof textEncode2.encodeInto !== "function") {
    return fallbackEncodeInto(str, target);
  }
  if (textCompat?.encodeInto === true) {
    return textEncode2.encodeInto(str, target);
  }
  if (textCompat?.encodeInto === false)
    return fallbackEncodeInto(str, target);
  try {
    return textEncode2.encodeInto(str, target);
  } catch (error) {
    if (!isSharedBufferEncodeIntoError(error))
      throw error;
    return fallbackEncodeInto(str, target);
  }
};
var browserDecode = (bytes, textCompat) => {
  if (textCompat?.decode === true)
    return textDecode2.decode(bytes);
  if (textCompat?.decode === false)
    return fallbackDecode(bytes);
  try {
    return textDecode2.decode(bytes);
  } catch (error) {
    if (!isSharedBufferDecodeError(error))
      throw error;
    return fallbackDecode(bytes);
  }
};
var createSharedDynamicBufferIO = ({
  sab,
  payloadConfig,
  textCompat
}) => {
  const bufferCtor = IS_BROWSER ? undefined : getBufferCtor();
  const resolvedPayload = resolvePayloadBufferOptions({
    sab,
    options: payloadConfig
  });
  const canGrow = resolvedPayload.mode === "growable";
  let lockSAB = sab ?? (canGrow ? createSharedArrayBuffer(resolvedPayload.payloadInitialBytes, resolvedPayload.payloadMaxByteLength) : createSharedArrayBuffer(resolvedPayload.payloadInitialBytes));
  let u8 = new Uint8Array(lockSAB, DYNAMIC_HEADER_BYTES);
  const requireBufferView = bufferCtor ? (buffer) => {
    const view = bufferCtor.from(buffer, DYNAMIC_HEADER_BYTES);
    if (view.buffer !== buffer) {
      throw new Error("Buffer view does not alias SharedArrayBuffer");
    }
    return view;
  } : undefined;
  let buf = requireBufferView?.(lockSAB);
  let f64 = new Float64Array(lockSAB, DYNAMIC_HEADER_BYTES);
  const capacityBytes = () => lockSAB.byteLength - DYNAMIC_HEADER_BYTES;
  const ensureCapacity = (neededBytes) => {
    if (capacityBytes() >= neededBytes)
      return true;
    if (!canGrow)
      return false;
    try {
      lockSAB = growSharedArrayBuffer(lockSAB, alignUpto64(DYNAMIC_HEADER_BYTES + neededBytes + DYNAMIC_SAFE_PADDING_BYTES));
    } catch {
      return false;
    }
    u8 = new Uint8Array(lockSAB, DYNAMIC_HEADER_BYTES, lockSAB.byteLength - DYNAMIC_HEADER_BYTES);
    buf = requireBufferView?.(lockSAB);
    f64 = new Float64Array(lockSAB, DYNAMIC_HEADER_BYTES, lockSAB.byteLength - DYNAMIC_HEADER_BYTES >>> 3);
    return true;
  };
  const readUtf8 = (start, end) => {
    if (IS_BROWSER) {
      return browserDecode(u8.subarray(start, end), textCompat);
    }
    return buf.toString("utf8", start, end);
  };
  const writeBinary = (src, start = 0) => {
    const bytes = canonicalDynamicUint8Array(src);
    if (!ensureCapacity(start + bytes.byteLength)) {
      return -1;
    }
    u8.set(bytes, start);
    return bytes.byteLength;
  };
  const writeBuffer = (src, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    u8.set(src, start);
    return bytes;
  };
  const writeArrayBuffer = (src, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    u8.set(new Uint8Array(src), start);
    return bytes;
  };
  const write8Binary = (src, start = 0) => {
    const bytes = src.byteLength;
    if (!ensureCapacity(start + bytes)) {
      return -1;
    }
    f64.set(src, start >>> 3);
    return bytes;
  };
  const readBytesCopy = (start, end) => u8.slice(start, end);
  const readBytesView = (start, end) => u8.subarray(start, end);
  const readBytesBufferCopy = (start, end) => {
    if (IS_BROWSER || !bufferCtor || !buf)
      return readBytesCopy(start, end);
    const length = Math.max(0, end - start | 0);
    const out = bufferCtor.allocUnsafe(length);
    if (length === 0)
      return out;
    buf.copy(out, 0, start, end);
    return out;
  };
  const readBytesArrayBufferCopy = (start, end) => {
    if (IS_BROWSER || !bufferCtor || !buf) {
      const out2 = readBytesCopy(start, end);
      return out2.buffer;
    }
    const length = Math.max(0, end - start | 0);
    if (length === 0)
      return new ArrayBuffer(0);
    const out = bufferCtor.allocUnsafeSlow(length);
    buf.copy(out, 0, start, end);
    return out.buffer;
  };
  const read8BytesFloatCopy = (start, end) => f64.slice(start >>> 3, end >>> 3);
  const read8BytesFloatView = (start, end) => f64.subarray(start >>> 3, end >>> 3);
  const writeUtf8 = (str, start, reservedBytes = str.length * 3) => {
    if (!ensureCapacity(start + reservedBytes)) {
      return -1;
    }
    const target = u8.subarray(start, start + reservedBytes);
    if (IS_BROWSER) {
      const { read: read2, written: written2 } = browserEncodeInto(str, target, textCompat);
      if (read2 !== str.length)
        return -1;
      return written2;
    }
    const { read, written } = textEncode2.encodeInto(str, target);
    if (read !== str.length)
      return -1;
    return written;
  };
  return {
    readUtf8,
    writeBinary,
    writeBuffer,
    writeArrayBuffer,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBufferCopy: readBytesBufferCopy,
    readBytesArrayBufferCopy,
    readArrayBufferCopy: readBytesArrayBufferCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    writeUtf8
  };
};
var createSharedStaticBufferIO = ({
  headersBuffer,
  slotStrideU32,
  textCompat
}) => {
  const bufferCtor = IS_BROWSER ? undefined : getBufferCtor();
  const buffer = headersBuffer instanceof Uint32Array ? headersBuffer.buffer : headersBuffer;
  const baseByteOffset = headersBuffer instanceof Uint32Array ? headersBuffer.byteOffset : 0;
  const u32Bytes = Uint32Array.BYTES_PER_ELEMENT;
  const slotStride = slotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  const writableBytes = HEADER_STATIC_PAYLOAD_U32 * u32Bytes;
  const baseU8 = new Uint8Array(buffer, baseByteOffset);
  const baseBuf = bufferCtor?.from(buffer, baseByteOffset);
  const baseF64 = new Float64Array(buffer, baseByteOffset, buffer.byteLength - baseByteOffset >>> 3);
  const slotStartBytes = (at) => getStridedSlotByteOffset({
    slotIndex: at,
    slotStrideU32: slotStride,
    baseByteOffset,
    baseU32: 0 /* header */
  });
  const slotByteOffsets = new Uint32Array(32 /* slots */);
  for (let i = 0;i < 32 /* slots */; i++) {
    slotByteOffsets[i] = slotStartBytes(i) - baseByteOffset;
  }
  const canWrite = (start, length) => (start | 0) >= 0 && start + length <= writableBytes;
  const writeUtf8 = (str, at) => {
    const start = slotByteOffsets[at];
    const target = baseU8.subarray(start, start + writableBytes);
    if (IS_BROWSER) {
      const { read: read2, written: written2 } = browserEncodeInto(str, target, textCompat);
      if (read2 !== str.length)
        return -1;
      return written2;
    }
    const { read, written } = textEncode2.encodeInto(str, target);
    if (read !== str.length)
      return -1;
    return written;
  };
  const readUtf8 = (start, end, at) => {
    const slotStart = slotByteOffsets[at];
    if (IS_BROWSER) {
      return browserDecode(baseU8.subarray(slotStart + start, slotStart + end), textCompat);
    }
    return baseBuf.toString("utf8", slotStart + start, slotStart + end);
  };
  const writeBinary = (src, at, start = 0) => {
    baseU8.set(src, slotByteOffsets[at] + start);
    return src.byteLength;
  };
  const writeBuffer = (src, at, start = 0) => {
    baseU8.set(src, slotByteOffsets[at] + start);
    return src.byteLength;
  };
  const writeArrayBuffer = (src, at, start = 0) => {
    const bytes = src.byteLength;
    baseU8.set(new Uint8Array(src), slotByteOffsets[at] + start);
    return bytes;
  };
  const writeExactUint8Array = (src, at, start = 0) => {
    baseU8.set(src, slotByteOffsets[at] + start);
    return src.byteLength;
  };
  const writeUint8Array = (src, at, start = 0) => {
    if (!isExactUint8Array(src))
      return -1;
    return writeExactUint8Array(src, at, start);
  };
  const write8Binary = (src, at, start = 0) => {
    const bytes = src.byteLength;
    if (!canWrite(start, bytes))
      return -1;
    baseF64.set(src, slotByteOffsets[at] + start >>> 3);
    return bytes;
  };
  const readBytesCopy = (start, end, at) => baseU8.slice(slotByteOffsets[at] + start, slotByteOffsets[at] + end);
  const readBytesView = (start, end, at) => baseU8.subarray(slotByteOffsets[at] + start, slotByteOffsets[at] + end);
  const readBytesBufferCopy = (start, end, at) => {
    if (IS_BROWSER || !bufferCtor || !baseBuf)
      return readBytesCopy(start, end, at);
    const length = end - start;
    const out = bufferCtor.allocUnsafe(length);
    const slotStart = slotByteOffsets[at];
    baseBuf.copy(out, 0, slotStart + start, slotStart + end);
    return out;
  };
  const readUint8ArrayBufferCopy = (start, end, at) => {
    if (IS_BROWSER || !bufferCtor)
      return readBytesCopy(start, end, at);
    const bytes = readBytesBufferCopy(start, end, at);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const readUint8ArraySliceCopy = (start, end, at) => readBytesCopy(start, end, at);
  const readUint8ArrayCopy = IS_BUN ? readUint8ArraySliceCopy : readUint8ArrayBufferCopy;
  const readBytesArrayBufferCopy = (start, end, at) => {
    if (IS_BROWSER || !bufferCtor || !baseBuf) {
      const out2 = readBytesCopy(start, end, at);
      return out2.buffer;
    }
    const length = Math.max(0, end - start | 0);
    if (length === 0)
      return new ArrayBuffer(0);
    const out = bufferCtor.allocUnsafeSlow(length);
    const slotStart = slotByteOffsets[at];
    baseBuf.copy(out, 0, slotStart + start, slotStart + end);
    return out.buffer;
  };
  const read8BytesFloatCopy = (start, end, at) => baseF64.slice(slotByteOffsets[at] + start >>> 3, slotByteOffsets[at] + end >>> 3);
  const read8BytesFloatView = (start, end, at) => baseF64.subarray(slotByteOffsets[at] + start >>> 3, slotByteOffsets[at] + end >>> 3);
  return {
    writeUtf8,
    readUtf8,
    writeBinary,
    writeBuffer,
    writeArrayBuffer,
    writeExactUint8Array,
    writeUint8Array,
    write8Binary,
    readBytesCopy,
    readBytesView,
    readBytesBufferCopy,
    readBufferCopy: readBytesBufferCopy,
    readUint8ArrayCopy,
    readUint8ArrayBufferCopy,
    readBytesArrayBufferCopy,
    readArrayBufferCopy: readBytesArrayBufferCopy,
    read8BytesFloatCopy,
    read8BytesFloatView,
    maxBytes: writableBytes
  };
};

// src/error.ts
var reasonFrom = (task, type, detail) => {
  switch (type) {
    case 0 /* Function */: {
      const name = typeof task.value === "function" ? task.value.name || "<anonymous>" : "<unknown>";
      return `KNT_ERROR_0: Function is not a valid type; name: ${name}`;
    }
    case 1 /* Symbol */:
      return "KNT_ERROR_1: Symbol must use Symbol.for(...) keys";
    case 2 /* Json */:
      return detail == null || detail.length === 0 ? "KNT_ERROR_2: JSON stringify failed; payload must be JSON-safe" : `KNT_ERROR_2: JSON stringify failed; ${detail}`;
    case 3 /* Serializable */:
      return detail == null || detail.length === 0 ? "KNT_ERROR_3: Unsupported payload type; serialize it yourself" : `KNT_ERROR_3: Unsupported payload type; ${detail}`;
  }
};
var encoderError = ({
  task,
  type,
  onPromise,
  detail
}) => {
  const reason = reasonFrom(task, type, detail);
  if (!RUNTIME_IS_MAIN_THREAD) {
    task.value = reason;
    task[0 /* FlagsToHost */] = 1 /* Reject */;
    return false;
  }
  if (onPromise == null) {
    throw new TypeError(reason);
  }
  if (!beginPromisePayload(task))
    return false;
  queueMicrotask(() => {
    finishPromisePayload(task);
    task.value = reason;
    onPromise(task, true, reason);
  });
  return false;
};

// src/common/envelope.ts
class Envelope {
  header;
  payload;
  constructor(header, payload) {
    this.header = header;
    this.payload = payload;
  }
}

// src/memory/payloadCodec.ts
var memory = new ArrayBuffer(8);
var Float64View = new Float64Array(memory);
var BigInt64View = new BigInt64Array(memory);
var Uint32View = new Uint32Array(memory);
var textEncode3 = new TextEncoder;
var runtimeBufferClass = IS_BROWSER ? undefined : globalThis.Buffer;
var runtimeBufferByteLength = !IS_BROWSER && typeof runtimeBufferClass?.byteLength === "function" ? runtimeBufferClass.byteLength.bind(runtimeBufferClass) : undefined;
var isRuntimeBuffer = IS_BROWSER ? (_) => false : typeof runtimeBufferClass?.isBuffer === "function" ? runtimeBufferClass.isBuffer.bind(runtimeBufferClass) : (_) => false;
var isRuntimeUint8Array = IS_BROWSER ? (value) => value instanceof Uint8Array : (value) => value != null && typeof value === "object" && Object.getPrototypeOf(value) === Uint8Array.prototype;
var utf8ByteLength = IS_BROWSER || !runtimeBufferByteLength ? (text) => textEncode3.encode(text).byteLength : (text) => runtimeBufferByteLength(text, "utf8");
var BIGINT64_MIN = -(1n << 63n);
var BIGINT64_MAX = (1n << 63n) - 1n;
var { parse: parseJSON, stringify: stringifyJSON } = JSON;
var { for: symbolFor, keyFor: symbolKeyFor } = Symbol;
var objectGetPrototypeOf = Object.getPrototypeOf;
var objectHasOwn = Object.prototype.hasOwnProperty;
var arrayIsArray = Array.isArray;
var objectPrototype = Object.prototype;
var UNSUPPORTED_OBJECT_DETAIL = "Unsupported object type. Allowed: plain object, array, Error, Date, Envelope, Buffer, ArrayBuffer, DataView, and typed arrays. Serialize it yourself.";
var ENVELOPE_PAYLOAD_DETAIL = "Envelope payload must be an ArrayBuffer.";
var ENVELOPE_HEADER_DETAIL = "Envelope header must be a JSON-like value or string.";
var ENVELOPE_PROMISE_DETAIL = "Envelope header cannot contain Promise values.";
var DYNAMIC_PAYLOAD_LIMIT_DETAIL = "Dynamic payload exceeds maxPayloadBytes.";
var DYNAMIC_PAYLOAD_CAPACITY_DETAIL = "Dynamic payload buffer capacity exceeded.";
var isPlainJsonObject = (value) => {
  const proto = objectGetPrototypeOf(value);
  return proto === objectPrototype || proto === null;
};
var hasPromiseInEnvelopeHeader = (value, seen) => {
  if (value instanceof Promise)
    return true;
  if (value === null || typeof value !== "object")
    return false;
  const objectValue = value;
  const visited = seen ?? new Set;
  if (visited.has(objectValue))
    return false;
  visited.add(objectValue);
  if (arrayIsArray(objectValue)) {
    const list = objectValue;
    for (let i = 0;i < list.length; i++) {
      if (hasPromiseInEnvelopeHeader(list[i], visited))
        return true;
    }
    return false;
  }
  if (!isPlainJsonObject(objectValue))
    return false;
  const record = objectValue;
  for (const key in record) {
    if (!objectHasOwn.call(record, key))
      continue;
    if (hasPromiseInEnvelopeHeader(record[key], visited))
      return true;
  }
  return false;
};
var toErrorCause = (cause) => {
  if (cause === null || cause === undefined)
    return cause;
  switch (typeof cause) {
    case "string":
    case "number":
    case "boolean":
      return cause;
    case "bigint":
      return cause.toString();
    case "symbol":
    case "function":
      return String(cause);
  }
  if (cause instanceof Error) {
    const nested = {
      name: cause.name,
      message: cause.message
    };
    if (typeof cause.stack === "string")
      nested.stack = cause.stack;
    if (objectHasOwn.call(cause, "cause")) {
      nested.cause = toErrorCause(cause.cause);
    }
    return nested;
  }
  try {
    return parseJSON(stringifyJSON(cause));
  } catch {
    return String(cause);
  }
};
var toErrorPayload = (error) => {
  const payload = {
    name: error.name,
    message: error.message
  };
  if (typeof error.stack === "string")
    payload.stack = error.stack;
  if (objectHasOwn.call(error, "cause")) {
    payload.cause = toErrorCause(error.cause);
  }
  return payload;
};
var parseErrorPayload = (raw) => {
  let parsed;
  try {
    parsed = parseJSON(raw);
  } catch {
    return new Error(raw);
  }
  if (parsed == null || typeof parsed !== "object") {
    return new Error(String(parsed));
  }
  const payload = parsed;
  const err = new Error(typeof payload.message === "string" ? payload.message : "");
  if (typeof payload.name === "string" && payload.name.length > 0) {
    err.name = payload.name;
  }
  if (typeof payload.stack === "string") {
    try {
      err.stack = payload.stack;
    } catch {}
  }
  if (objectHasOwn.call(payload, "cause")) {
    err.cause = payload.cause;
  }
  return err;
};
var decodeBigIntBinary = (bytes) => {
  const sign = bytes[0];
  let value = 0n;
  for (let i = bytes.length - 1;i >= 1; i--) {
    value = value << 8n | BigInt(bytes[i]);
  }
  return sign === 1 ? -value : value;
};
var initStaticIO = (headersBuffer, headerSlotStrideU32, textCompat) => {
  const slotStride = headerSlotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  const requiredBytes = getStridedRegionSpanBytes({
    slotCount: 32 /* slots */,
    slotStrideU32: slotStride,
    slotLengthU32: HEADER_STATIC_PAYLOAD_U32,
    baseU32: 0 /* header */
  });
  if (headersBuffer.byteLength < Math.max(requiredBytes, HEADER_BYTE_LENGTH)) {
    return null;
  }
  return createSharedStaticBufferIO({
    headersBuffer,
    slotStrideU32: slotStride,
    textCompat
  });
};
var requireStaticIO = (headersBuffer, headerSlotStrideU32, textCompat) => {
  const staticIO = initStaticIO(headersBuffer, headerSlotStrideU32, textCompat);
  if (staticIO === null) {
    throw new RangeError("headersBuffer is too small for static payload IO");
  }
  return staticIO;
};
var encodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  headerSlotStrideU32,
  textCompat,
  onPromise
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig
  });
  const maxPayloadBytes = resolvedPayloadConfig.maxPayloadBytes;
  const { allocTask, setSlotLength, free } = register({
    lockSector
  });
  const {
    writeBinary: writeDynamicBinary,
    writeBuffer: writeDynamicBuffer,
    writeArrayBuffer: writeDynamicArrayBuffer,
    write8Binary: writeDynamic8Binary,
    writeUtf8: writeDynamicUtf8
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
    textCompat: textCompat?.payload
  });
  const {
    maxBytes: staticMaxBytes,
    writeBinary: writeStaticBinary,
    writeBuffer: writeStaticBuffer,
    writeArrayBuffer: writeStaticArrayBuffer,
    writeExactUint8Array: writeStaticExactUint8Array,
    write8Binary: writeStatic8Binary,
    writeUtf8: writeStaticUtf8
  } = requireStaticIO(headersBuffer, headerSlotStrideU32, textCompat?.headers);
  const dynamicLimitError = (task, actualBytes, label) => encoderError({
    task,
    type: 3 /* Serializable */,
    onPromise,
    detail: `${DYNAMIC_PAYLOAD_LIMIT_DETAIL} limit=${maxPayloadBytes}; ` + `actual=${actualBytes}; type=${label}.`
  });
  const dynamicCapacityError = (task) => encoderError({
    task,
    type: 3 /* Serializable */,
    onPromise,
    detail: DYNAMIC_PAYLOAD_CAPACITY_DETAIL
  });
  const ensureWithinDynamicLimit = (task, bytes, label) => {
    if (bytes <= maxPayloadBytes)
      return true;
    return dynamicLimitError(task, bytes, label);
  };
  const dynamicUtf8ReserveBytesWithExtra = (task, text, extraBytes, label) => {
    const estimatedBytes = text.length * 3;
    const estimatedTotal = estimatedBytes + extraBytes;
    if (estimatedTotal <= maxPayloadBytes)
      return estimatedBytes;
    const exactBytes = utf8ByteLength(text);
    const exactTotal = exactBytes + extraBytes;
    if (exactTotal > maxPayloadBytes) {
      dynamicLimitError(task, exactTotal, label);
      return -1;
    }
    return exactBytes;
  };
  const dynamicUtf8ReserveBytes = (task, text, label) => dynamicUtf8ReserveBytesWithExtra(task, text, 0, label);
  const reserveDynamic = (task, bytes) => {
    task[5 /* PayloadLen */] = bytes;
    return allocTask(task);
  };
  let objectDynamicSlot = -1;
  const reserveDynamicObject = (task, bytes) => {
    task[5 /* PayloadLen */] = bytes;
    const reservedSlot = allocTask(task);
    objectDynamicSlot = reservedSlot;
    return reservedSlot;
  };
  const rollbackObjectDynamic = () => {
    if (objectDynamicSlot !== -1) {
      free(objectDynamicSlot);
      objectDynamicSlot = -1;
    }
  };
  const failDynamicWriteAfterReserve = (task, reservedSlot) => {
    free(reservedSlot);
    if (objectDynamicSlot === reservedSlot)
      objectDynamicSlot = -1;
    return dynamicCapacityError(task);
  };
  let bigintScratch = new Uint8Array(16);
  const encodeBigIntIntoScratch = (value) => {
    let sign = 0;
    let abs = value;
    if (value < 0n) {
      sign = 1;
      abs = -value;
    }
    let at = 1;
    while (abs > 0n) {
      if (at >= bigintScratch.byteLength) {
        const next = new Uint8Array(bigintScratch.byteLength << 1);
        next.set(bigintScratch, 0);
        bigintScratch = next;
      }
      bigintScratch[at++] = Number(abs & 0xffn);
      abs >>= 8n;
    }
    bigintScratch[0] = sign;
    return at;
  };
  const clearBigIntScratch = (used) => {
    bigintScratch.fill(0, 0, used);
  };
  const encodeErrorObject = (task, error) => {
    let text;
    try {
      text = stringifyJSON(toErrorPayload(error));
    } catch (encodeErrorReason) {
      const detail = encodeErrorReason instanceof Error ? encodeErrorReason.message : String(encodeErrorReason);
      return encoderError({
        task,
        type: 3 /* Serializable */,
        onPromise,
        detail
      });
    }
    const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Error");
    if (reserveBytes < 0)
      return false;
    task[2 /* Type */] = 24 /* Error */;
    const reservedSlot = reserveDynamicObject(task, reserveBytes);
    const written = writeDynamicUtf8(text, task[3 /* Start */], reserveBytes);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectBinary = (task, slotIndex, bytesView, dynamicType, staticType) => {
    const bytes = bytesView.byteLength;
    if (bytes <= staticMaxBytes) {
      const written2 = writeStaticBinary(bytesView, slotIndex);
      if (written2 !== -1) {
        task[2 /* Type */] = staticType;
        task[5 /* PayloadLen */] = written2;
        task.value = null;
        return true;
      }
    }
    task[2 /* Type */] = dynamicType;
    if (!ensureWithinDynamicLimit(task, bytes, PayloadBuffer[dynamicType])) {
      return false;
    }
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamicBinary(bytesView, task[3 /* Start */]);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectUint8Array = (task, slotIndex, bytesView) => {
    const bytes = bytesView.byteLength;
    if (bytes <= staticMaxBytes) {
      writeStaticExactUint8Array(bytesView, slotIndex);
      task[2 /* Type */] = 18 /* StaticBinary */;
      task[5 /* PayloadLen */] = bytes;
      task.value = null;
      return true;
    }
    task[2 /* Type */] = 17 /* Binary */;
    if (!ensureWithinDynamicLimit(task, bytes, "Binary"))
      return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamicBinary(bytesView, task[3 /* Start */]);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectBuffer = (task, slotIndex, buffer) => {
    const bytes = buffer.byteLength;
    if (bytes <= staticMaxBytes) {
      const written2 = writeStaticBuffer(buffer, slotIndex);
      if (written2 !== -1) {
        task[2 /* Type */] = 39 /* StaticBuffer */;
        task[5 /* PayloadLen */] = written2;
        task.value = null;
        return true;
      }
    }
    task[2 /* Type */] = 38 /* Buffer */;
    if (!ensureWithinDynamicLimit(task, bytes, "Buffer"))
      return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamicBuffer(buffer, task[3 /* Start */]);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectFloat64Array = (task, slotIndex, float64) => {
    const bytes = float64.byteLength;
    if (bytes <= staticMaxBytes) {
      const written2 = writeStatic8Binary(float64, slotIndex);
      if (written2 !== -1) {
        task[2 /* Type */] = 32 /* StaticFloat64Array */;
        task[5 /* PayloadLen */] = written2;
        task.value = null;
        return true;
      }
    }
    task[2 /* Type */] = 20 /* Float64Array */;
    if (!ensureWithinDynamicLimit(task, bytes, "Float64Array"))
      return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamic8Binary(float64, task[3 /* Start */]);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectArrayBuffer = (task, slotIndex, arrayBuffer) => {
    const bytes = arrayBuffer.byteLength;
    if (bytes <= staticMaxBytes) {
      const written2 = writeStaticArrayBuffer(arrayBuffer, slotIndex);
      if (written2 !== -1) {
        task[2 /* Type */] = 37 /* StaticArrayBuffer */;
        task[5 /* PayloadLen */] = written2;
        task.value = null;
        return true;
      }
    }
    task[2 /* Type */] = 36 /* ArrayBuffer */;
    if (!ensureWithinDynamicLimit(task, bytes, "ArrayBuffer"))
      return false;
    const reservedSlot = reserveDynamicObject(task, bytes);
    const written = writeDynamicArrayBuffer(arrayBuffer, task[3 /* Start */]);
    if (written < 0)
      return failDynamicWriteAfterReserve(task, reservedSlot);
    task[5 /* PayloadLen */] = written;
    setSlotLength(reservedSlot, written);
    task.value = null;
    return true;
  };
  const encodeObjectDate = (task, date) => {
    Float64View[0] = date.getTime();
    task[2 /* Type */] = 25 /* Date */;
    task[3 /* Start */] = Uint32View[0];
    task[4 /* End */] = Uint32View[1];
    task.value = null;
    return true;
  };
  const encodeObjectEnvelope = (task, slotIndex, envelope) => {
    const header = envelope.header;
    const payload2 = envelope.payload;
    const headerIsString = typeof header === "string";
    if (!(payload2 instanceof ArrayBuffer)) {
      return encoderError({
        task,
        type: 3 /* Serializable */,
        onPromise,
        detail: ENVELOPE_PAYLOAD_DETAIL
      });
    }
    if (hasPromiseInEnvelopeHeader(header)) {
      return encoderError({
        task,
        type: 3 /* Serializable */,
        onPromise,
        detail: ENVELOPE_PROMISE_DETAIL
      });
    }
    let headerText;
    if (headerIsString) {
      headerText = header;
    } else {
      try {
        headerText = stringifyJSON(header);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return encoderError({
          task,
          type: 2 /* Json */,
          onPromise,
          detail
        });
      }
    }
    if (typeof headerText !== "string") {
      return encoderError({
        task,
        type: 3 /* Serializable */,
        onPromise,
        detail: ENVELOPE_HEADER_DETAIL
      });
    }
    const payloadBytes = new Uint8Array(payload2);
    const payloadLength = payloadBytes.byteLength;
    const payloadReserveBytes = payloadLength > 0 ? payloadLength : 1;
    const staticHeaderWritten = writeStaticUtf8(headerText, slotIndex);
    if (staticHeaderWritten !== -1) {
      if (!ensureWithinDynamicLimit(task, payloadReserveBytes, "EnvelopeStaticHeaderPayload"))
        return false;
      const reservedSlot2 = reserveDynamicObject(task, payloadReserveBytes);
      task[2 /* Type */] = headerIsString ? 42 /* EnvelopeStaticHeaderString */ : 40 /* EnvelopeStaticHeader */;
      task[5 /* PayloadLen */] = staticHeaderWritten;
      task[4 /* End */] = payloadLength;
      if (payloadLength > 0) {
        const payloadWritten = writeDynamicBinary(payloadBytes, task[3 /* Start */]);
        if (payloadWritten < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot2);
        }
        setSlotLength(reservedSlot2, payloadWritten);
      }
      task.value = null;
      return true;
    }
    const headerReserveBytes = dynamicUtf8ReserveBytesWithExtra(task, headerText, payloadLength, headerIsString ? "EnvelopeDynamicHeaderString" : "EnvelopeDynamicHeader");
    if (headerReserveBytes < 0)
      return false;
    task[2 /* Type */] = headerIsString ? 43 /* EnvelopeDynamicHeaderString */ : 41 /* EnvelopeDynamicHeader */;
    const reservedSlot = reserveDynamicObject(task, headerReserveBytes + payloadLength);
    const baseStart = task[3 /* Start */];
    const writtenHeaderBytes = writeDynamicUtf8(headerText, baseStart, headerReserveBytes);
    if (writtenHeaderBytes < 0) {
      return failDynamicWriteAfterReserve(task, reservedSlot);
    }
    if (payloadLength > 0) {
      const payloadWritten = writeDynamicBinary(payloadBytes, baseStart + writtenHeaderBytes);
      if (payloadWritten < 0) {
        return failDynamicWriteAfterReserve(task, reservedSlot);
      }
    }
    task[5 /* PayloadLen */] = writtenHeaderBytes;
    task[4 /* End */] = payloadLength;
    setSlotLength(reservedSlot, writtenHeaderBytes + payloadLength);
    task.value = null;
    return true;
  };
  const encodeObjectPromise = (task, promise) => {
    if (beginPromisePayload(task)) {
      promise.then((value) => {
        finishPromisePayload(task);
        task.value = value;
        onPromise(task, false, value);
      }, (reason) => {
        finishPromisePayload(task);
        task.value = reason;
        onPromise(task, true, reason);
      });
    }
    return false;
  };
  const encodeDispatch = (task, slotIndex) => {
    const args = task.value;
    switch (typeof args) {
      case "bigint":
        if (args < BIGINT64_MIN || args > BIGINT64_MAX) {
          const binaryBytes = encodeBigIntIntoScratch(args);
          const binary = bigintScratch.subarray(0, binaryBytes);
          if (binaryBytes <= staticMaxBytes) {
            const written2 = writeStaticBinary(binary, slotIndex);
            if (written2 !== -1) {
              task[2 /* Type */] = 29 /* StaticBigInt */;
              task[5 /* PayloadLen */] = written2;
              clearBigIntScratch(binaryBytes);
              task.value = null;
              return true;
            }
          }
          task[2 /* Type */] = 28 /* BigInt */;
          if (!ensureWithinDynamicLimit(task, binaryBytes, "BigInt")) {
            clearBigIntScratch(binaryBytes);
            return false;
          }
          const reservedSlot = reserveDynamic(task, binaryBytes);
          const written = writeDynamicBinary(binary, task[3 /* Start */]);
          if (written < 0) {
            clearBigIntScratch(binaryBytes);
            return failDynamicWriteAfterReserve(task, reservedSlot);
          }
          task[5 /* PayloadLen */] = written;
          setSlotLength(reservedSlot, written);
          clearBigIntScratch(binaryBytes);
          task.value = null;
          return true;
        }
        BigInt64View[0] = args;
        task[2 /* Type */] = 2 /* BigInt */;
        task[3 /* Start */] = Uint32View[0];
        task[4 /* End */] = Uint32View[1];
        return true;
      case "boolean":
        task[2 /* Type */] = task.value === true ? 3 /* True */ : 4 /* False */;
        return true;
      case "function":
        return encoderError({
          task,
          type: 0 /* Function */,
          onPromise
        });
      case "number":
        if (args !== args) {
          task[2 /* Type */] = 6 /* NaN */;
          return true;
        }
        Float64View[0] = args;
        task[2 /* Type */] = 9 /* Float64 */;
        task[3 /* Start */] = Uint32View[0];
        task[4 /* End */] = Uint32View[1];
        return true;
      case "object":
        if (args === null) {
          task[2 /* Type */] = 10 /* Null */;
          return true;
        }
        objectDynamicSlot = -1;
        try {
          const objectValue = args;
          const objectProto = objectGetPrototypeOf(objectValue);
          if (isRuntimeUint8Array(objectValue)) {
            return encodeObjectUint8Array(task, slotIndex, objectValue);
          }
          if (arrayIsArray(objectValue) || objectProto === objectPrototype || objectProto === null) {
            let text;
            try {
              text = stringifyJSON(objectValue);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              return encoderError({
                task,
                type: 2 /* Json */,
                onPromise,
                detail
              });
            }
            if (text.length <= staticMaxBytes) {
              const written2 = writeStaticUtf8(text, slotIndex);
              if (written2 !== -1) {
                task[2 /* Type */] = 16 /* StaticJson */;
                task[5 /* PayloadLen */] = written2;
                task.value = null;
                return true;
              }
            }
            task[2 /* Type */] = 12 /* Json */;
            const reserveBytes = dynamicUtf8ReserveBytes(task, text, "Json");
            if (reserveBytes < 0)
              return false;
            const reservedSlot = reserveDynamicObject(task, reserveBytes);
            const written = writeDynamicUtf8(text, task[3 /* Start */], reserveBytes);
            if (written < 0) {
              return failDynamicWriteAfterReserve(task, reservedSlot);
            }
            task[5 /* PayloadLen */] = written;
            setSlotLength(reservedSlot, written);
            task.value = null;
            return true;
          }
          const objectCtor = objectValue.constructor;
          if (isRuntimeBuffer(objectValue)) {
            return encodeObjectBuffer(task, slotIndex, objectValue);
          }
          switch (objectCtor) {
            case ArrayBuffer:
              return encodeObjectArrayBuffer(task, slotIndex, objectValue);
            case Int32Array: {
              const int32 = objectValue;
              return encodeObjectBinary(task, slotIndex, new Uint8Array(int32.buffer, int32.byteOffset, int32.byteLength), 19 /* Int32Array */, 31 /* StaticInt32Array */);
            }
            case Float64Array:
              return encodeObjectFloat64Array(task, slotIndex, objectValue);
            case BigInt64Array: {
              const bigInt64 = objectValue;
              return encodeObjectBinary(task, slotIndex, new Uint8Array(bigInt64.buffer, bigInt64.byteOffset, bigInt64.byteLength), 21 /* BigInt64Array */, 33 /* StaticBigInt64Array */);
            }
            case BigUint64Array: {
              const bigUint64 = objectValue;
              return encodeObjectBinary(task, slotIndex, new Uint8Array(bigUint64.buffer, bigUint64.byteOffset, bigUint64.byteLength), 22 /* BigUint64Array */, 34 /* StaticBigUint64Array */);
            }
            case DataView: {
              const dataView = objectValue;
              return encodeObjectBinary(task, slotIndex, new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength), 23 /* DataView */, 35 /* StaticDataView */);
            }
            case Date:
              return encodeObjectDate(task, objectValue);
            case Envelope:
              return encodeObjectEnvelope(task, slotIndex, objectValue);
            case Promise:
              return encodeObjectPromise(task, objectValue);
            case Error:
              return encodeErrorObject(task, objectValue);
          }
          if (objectValue instanceof Date) {
            return encodeObjectDate(task, objectValue);
          }
          if (objectValue instanceof Envelope) {
            return encodeObjectEnvelope(task, slotIndex, objectValue);
          }
          if (objectValue instanceof Promise) {
            return encodeObjectPromise(task, objectValue);
          }
          if (objectValue instanceof Error) {
            return encodeErrorObject(task, objectValue);
          }
          return encoderError({
            task,
            type: 3 /* Serializable */,
            onPromise,
            detail: UNSUPPORTED_OBJECT_DETAIL
          });
        } catch (error) {
          rollbackObjectDynamic();
          const detail = error instanceof Error ? error.message : String(error);
          return encoderError({
            task,
            type: 3 /* Serializable */,
            onPromise,
            detail
          });
        }
      case "string": {
        const text = args;
        if (text.length <= staticMaxBytes) {
          const written2 = writeStaticUtf8(text, slotIndex);
          if (written2 !== -1) {
            task[2 /* Type */] = 15 /* StaticString */;
            task[5 /* PayloadLen */] = written2;
            task.value = null;
            return true;
          }
        }
        task[2 /* Type */] = 11 /* String */;
        const reserveBytes = dynamicUtf8ReserveBytes(task, text, "String");
        if (reserveBytes < 0)
          return false;
        const reservedSlot = reserveDynamic(task, reserveBytes);
        const written = writeDynamicUtf8(text, task[3 /* Start */], reserveBytes);
        if (written < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        task[5 /* PayloadLen */] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return true;
      }
      case "symbol": {
        const key = symbolKeyFor(args);
        if (key === undefined) {
          return encoderError({
            task,
            type: 1 /* Symbol */,
            onPromise
          });
        }
        if (key.length * 3 <= staticMaxBytes) {
          const written2 = writeStaticUtf8(key, slotIndex);
          if (written2 !== -1) {
            task[2 /* Type */] = 27 /* StaticSymbol */;
            task[5 /* PayloadLen */] = written2;
            task.value = null;
            return true;
          }
        }
        task[2 /* Type */] = 26 /* Symbol */;
        const reserveBytes = dynamicUtf8ReserveBytes(task, key, "Symbol");
        if (reserveBytes < 0)
          return false;
        const reservedSlot = reserveDynamic(task, reserveBytes);
        const written = writeDynamicUtf8(key, task[3 /* Start */], reserveBytes);
        if (written < 0) {
          return failDynamicWriteAfterReserve(task, reservedSlot);
        }
        task[5 /* PayloadLen */] = written;
        setSlotLength(reservedSlot, written);
        task.value = null;
        return true;
      }
      case "undefined":
        task[2 /* Type */] = 5 /* Undefined */;
        return true;
    }
    return false;
  };
  return encodeDispatch;
};
var decodePayload = ({
  lockSector,
  payload,
  sab,
  payloadConfig,
  headersBuffer,
  headerSlotStrideU32,
  textCompat,
  host
}) => {
  const payloadSab = payload?.sab ?? sab;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payloadSab,
    options: payload?.config ?? payloadConfig
  });
  const { free } = register({
    lockSector
  });
  const freeTaskSlot = (task) => free(getTaskSlotIndex(task));
  const {
    readUtf8: readDynamicUtf8,
    readBytesCopy: readDynamicBytesCopy,
    readBytesBufferCopy: readDynamicBufferCopy,
    readBufferCopy: readDynamicBuffer,
    readBytesArrayBufferCopy: readDynamicArrayBufferCopy,
    readArrayBufferCopy: readDynamicArrayBuffer,
    read8BytesFloatCopy: readDynamic8BytesFloatCopy,
    read8BytesFloatView: readDynamic8BytesFloatView
  } = createSharedDynamicBufferIO({
    sab: payloadSab,
    payloadConfig: resolvedPayloadConfig,
    textCompat: textCompat?.payload
  });
  const {
    readUtf8: readStaticUtf8,
    readBytesCopy: readStaticBytesCopy,
    readBytesBufferCopy: readStaticBufferCopy,
    readBufferCopy: readStaticBuffer,
    readUint8ArrayCopy: readStaticUint8ArrayCopy,
    readBytesArrayBufferCopy: readStaticArrayBufferCopy,
    readArrayBufferCopy: readStaticArrayBuffer,
    read8BytesFloatCopy: readStatic8BytesFloatCopy
  } = requireStaticIO(headersBuffer, headerSlotStrideU32, textCompat?.headers);
  return (task, slotIndex, specialFlags) => {
    switch (task[2 /* Type */]) {
      case 2 /* BigInt */:
        Uint32View[0] = task[3 /* Start */];
        Uint32View[1] = task[4 /* End */];
        task.value = BigInt64View[0];
        return;
      case 3 /* True */:
        task.value = true;
        return;
      case 4 /* False */:
        task.value = false;
        return;
      case 9 /* Float64 */:
        Uint32View[0] = task[3 /* Start */];
        Uint32View[1] = task[4 /* End */];
        task.value = Float64View[0];
        return;
      case 6 /* NaN */:
        task.value = NaN;
        return;
      case 10 /* Null */:
        task.value = null;
        return;
      case 5 /* Undefined */:
        task.value = undefined;
        return;
      case 11 /* String */:
        task.value = readDynamicUtf8(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        freeTaskSlot(task);
        return;
      case 15 /* StaticString */:
        task.value = readStaticUtf8(0, task[5 /* PayloadLen */], slotIndex);
        return;
      case 12 /* Json */:
        task.value = parseJSON(readDynamicUtf8(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]));
        freeTaskSlot(task);
        return;
      case 16 /* StaticJson */:
        task.value = parseJSON(readStaticUtf8(0, task[5 /* PayloadLen */], slotIndex));
        return;
      case 40 /* EnvelopeStaticHeader */:
      case 42 /* EnvelopeStaticHeaderString */: {
        const rawHeader = readStaticUtf8(0, task[5 /* PayloadLen */], slotIndex);
        const header = task[2 /* Type */] === 42 /* EnvelopeStaticHeaderString */ ? rawHeader : parseJSON(rawHeader);
        const payloadLength = task[4 /* End */];
        const payload2 = payloadLength > 0 ? readDynamicArrayBufferCopy(task[3 /* Start */], task[3 /* Start */] + payloadLength) : new ArrayBuffer(0);
        task.value = new Envelope(header, payload2);
        freeTaskSlot(task);
        return;
      }
      case 41 /* EnvelopeDynamicHeader */:
      case 43 /* EnvelopeDynamicHeaderString */: {
        const headerStart = task[3 /* Start */];
        const payloadStart = headerStart + task[5 /* PayloadLen */];
        const payloadLength = task[4 /* End */];
        const rawHeader = readDynamicUtf8(headerStart, payloadStart);
        const header = task[2 /* Type */] === 43 /* EnvelopeDynamicHeaderString */ ? rawHeader : parseJSON(rawHeader);
        const payload2 = payloadLength > 0 ? readDynamicArrayBufferCopy(payloadStart, payloadStart + payloadLength) : new ArrayBuffer(0);
        task.value = new Envelope(header, payload2);
        freeTaskSlot(task);
        return;
      }
      case 28 /* BigInt */:
        task.value = decodeBigIntBinary(readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]));
        freeTaskSlot(task);
        return;
      case 29 /* StaticBigInt */:
        task.value = decodeBigIntBinary(readStaticBufferCopy(0, task[5 /* PayloadLen */], slotIndex));
        return;
      case 26 /* Symbol */:
        task.value = symbolFor(readDynamicUtf8(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]));
        freeTaskSlot(task);
        return;
      case 27 /* StaticSymbol */:
        task.value = symbolFor(readStaticUtf8(0, task[5 /* PayloadLen */], slotIndex));
        return;
      case 19 /* Int32Array */: {
        const bytes = readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        task.value = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
        freeTaskSlot(task);
        return;
      }
      case 31 /* StaticInt32Array */: {
        const bytes = readStaticBufferCopy(0, task[5 /* PayloadLen */], slotIndex);
        task.value = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
        return;
      }
      case 20 /* Float64Array */: {
        task.value = readDynamic8BytesFloatCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        freeTaskSlot(task);
        return;
      }
      case 32 /* StaticFloat64Array */:
        task.value = readStatic8BytesFloatCopy(0, task[5 /* PayloadLen */], slotIndex);
        return;
      case 21 /* BigInt64Array */: {
        const bytes = readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        task.value = new BigInt64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 3);
        freeTaskSlot(task);
        return;
      }
      case 33 /* StaticBigInt64Array */: {
        const bytes = readStaticBufferCopy(0, task[5 /* PayloadLen */], slotIndex);
        task.value = new BigInt64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 3);
        return;
      }
      case 22 /* BigUint64Array */: {
        const bytes = readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        task.value = new BigUint64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 3);
        freeTaskSlot(task);
        return;
      }
      case 34 /* StaticBigUint64Array */: {
        const bytes = readStaticBufferCopy(0, task[5 /* PayloadLen */], slotIndex);
        task.value = new BigUint64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 3);
        return;
      }
      case 23 /* DataView */: {
        const bytes = readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        freeTaskSlot(task);
        return;
      }
      case 35 /* StaticDataView */: {
        const bytes = readStaticBufferCopy(0, task[5 /* PayloadLen */], slotIndex);
        task.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return;
      }
      case 25 /* Date */:
        Uint32View[0] = task[3 /* Start */];
        Uint32View[1] = task[4 /* End */];
        task.value = new Date(Float64View[0]);
        return;
      case 24 /* Error */:
        task.value = parseErrorPayload(readDynamicUtf8(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]));
        freeTaskSlot(task);
        return;
      case 17 /* Binary */:
        {
          const buffer = readDynamicBufferCopy(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
          task.value = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        }
        freeTaskSlot(task);
        return;
      case 18 /* StaticBinary */:
        task.value = readStaticUint8ArrayCopy(0, task[5 /* PayloadLen */], slotIndex);
        return;
      case 36 /* ArrayBuffer */:
        task.value = readDynamicArrayBuffer(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        freeTaskSlot(task);
        return;
      case 37 /* StaticArrayBuffer */:
        task.value = readStaticArrayBuffer(0, task[5 /* PayloadLen */], slotIndex);
        return;
      case 38 /* Buffer */:
        task.value = readDynamicBuffer(task[3 /* Start */], task[3 /* Start */] + task[5 /* PayloadLen */]);
        freeTaskSlot(task);
        return;
      case 39 /* StaticBuffer */:
        task.value = readStaticBuffer(0, task[5 /* PayloadLen */], slotIndex);
        return;
    }
  };
};

// src/memory/lock.ts
var PayloadBuffer;
((PayloadBuffer2) => {
  PayloadBuffer2[PayloadBuffer2["BORDER_SIGNAL_BUFFER"] = 11] = "BORDER_SIGNAL_BUFFER";
  PayloadBuffer2[PayloadBuffer2["String"] = 11] = "String";
  PayloadBuffer2[PayloadBuffer2["Json"] = 12] = "Json";
  PayloadBuffer2[PayloadBuffer2["StaticString"] = 15] = "StaticString";
  PayloadBuffer2[PayloadBuffer2["StaticJson"] = 16] = "StaticJson";
  PayloadBuffer2[PayloadBuffer2["Binary"] = 17] = "Binary";
  PayloadBuffer2[PayloadBuffer2["StaticBinary"] = 18] = "StaticBinary";
  PayloadBuffer2[PayloadBuffer2["Int32Array"] = 19] = "Int32Array";
  PayloadBuffer2[PayloadBuffer2["Float64Array"] = 20] = "Float64Array";
  PayloadBuffer2[PayloadBuffer2["BigInt64Array"] = 21] = "BigInt64Array";
  PayloadBuffer2[PayloadBuffer2["BigUint64Array"] = 22] = "BigUint64Array";
  PayloadBuffer2[PayloadBuffer2["DataView"] = 23] = "DataView";
  PayloadBuffer2[PayloadBuffer2["Error"] = 24] = "Error";
  PayloadBuffer2[PayloadBuffer2["Date"] = 25] = "Date";
  PayloadBuffer2[PayloadBuffer2["Symbol"] = 26] = "Symbol";
  PayloadBuffer2[PayloadBuffer2["StaticSymbol"] = 27] = "StaticSymbol";
  PayloadBuffer2[PayloadBuffer2["BigInt"] = 28] = "BigInt";
  PayloadBuffer2[PayloadBuffer2["StaticBigInt"] = 29] = "StaticBigInt";
  PayloadBuffer2[PayloadBuffer2["StaticInt32Array"] = 31] = "StaticInt32Array";
  PayloadBuffer2[PayloadBuffer2["StaticFloat64Array"] = 32] = "StaticFloat64Array";
  PayloadBuffer2[PayloadBuffer2["StaticBigInt64Array"] = 33] = "StaticBigInt64Array";
  PayloadBuffer2[PayloadBuffer2["StaticBigUint64Array"] = 34] = "StaticBigUint64Array";
  PayloadBuffer2[PayloadBuffer2["StaticDataView"] = 35] = "StaticDataView";
  PayloadBuffer2[PayloadBuffer2["ArrayBuffer"] = 36] = "ArrayBuffer";
  PayloadBuffer2[PayloadBuffer2["StaticArrayBuffer"] = 37] = "StaticArrayBuffer";
  PayloadBuffer2[PayloadBuffer2["Buffer"] = 38] = "Buffer";
  PayloadBuffer2[PayloadBuffer2["StaticBuffer"] = 39] = "StaticBuffer";
  PayloadBuffer2[PayloadBuffer2["EnvelopeStaticHeader"] = 40] = "EnvelopeStaticHeader";
  PayloadBuffer2[PayloadBuffer2["EnvelopeDynamicHeader"] = 41] = "EnvelopeDynamicHeader";
  PayloadBuffer2[PayloadBuffer2["EnvelopeStaticHeaderString"] = 42] = "EnvelopeStaticHeaderString";
  PayloadBuffer2[PayloadBuffer2["EnvelopeDynamicHeaderString"] = 43] = "EnvelopeDynamicHeaderString";
})(PayloadBuffer ||= {});
var LOCK_CACHE_LINE_BYTES = 64;
var LOCK_SECTOR_BYTES = 256;
var PromisePayloadMarker = Symbol.for("knitting.promise.payload");
var pendingPromisePayloads = new WeakSet;
var beginPromisePayload = (task) => {
  if (pendingPromisePayloads.has(task))
    return false;
  pendingPromisePayloads.add(task);
  return true;
};
var finishPromisePayload = (task) => {
  pendingPromisePayloads.delete(task);
};
var isPromisePayloadPending = (task) => pendingPromisePayloads.has(task);
var TASK_SLOT_INDEX_BITS = 5;
var TASK_SLOT_INDEX_MASK = (1 << TASK_SLOT_INDEX_BITS) - 1;
var TASK_SLOT_META_BITS = 32 - TASK_SLOT_INDEX_BITS;
var TASK_SLOT_META_VALUE_MASK = 4294967295 >>> TASK_SLOT_INDEX_BITS;
var TASK_SLOT_META_PACKED_MASK = ~TASK_SLOT_INDEX_MASK >>> 0;
var TASK_FUNCTION_ID_BITS = 16;
var TASK_FUNCTION_ID_MASK = (1 << TASK_FUNCTION_ID_BITS) - 1;
var TASK_FUNCTION_META_BITS = 32 - TASK_FUNCTION_ID_BITS;
var TASK_FUNCTION_META_VALUE_MASK = 4294967295 >>> TASK_FUNCTION_ID_BITS;
var TASK_FUNCTION_META_PACKED_MASK = ~TASK_FUNCTION_ID_MASK >>> 0;
var getTaskFunctionMeta = (task) => task[0 /* FunctionID */] >>> TASK_FUNCTION_ID_BITS & TASK_FUNCTION_META_VALUE_MASK;
var getTaskSlotIndex = (task) => task[6 /* slotBuffer */] & TASK_SLOT_INDEX_MASK;
var getTaskSlotMeta = (task) => task[6 /* slotBuffer */] >>> TASK_SLOT_INDEX_BITS & TASK_SLOT_META_VALUE_MASK;
var LOCK_WORD_BYTES = Int32Array.BYTES_PER_ELEMENT;
var LOCK_HOST_BITS_OFFSET_BYTES = 0 /* paddingLock */;
var LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES;
var LOCK_SECTOR_BYTE_LENGTH = LOCK_SECTOR_BYTES;
var PAYLOAD_LOCK_HOST_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 2;
var PAYLOAD_LOCK_WORKER_BITS_OFFSET_BYTES = LOCK_CACHE_LINE_BYTES * 3;
var HEADER_SLOT_STRIDE_U32 = 0 /* header */ + 144 /* TotalBuff */;
var HEADER_SLOT_STRIDE_BYTES = HEADER_SLOT_STRIDE_U32 * Uint32Array.BYTES_PER_ELEMENT;
var HEADER_TASK_LINE_U32 = LOCK_CACHE_LINE_BYTES / Uint32Array.BYTES_PER_ELEMENT;
var HEADER_STATIC_PAYLOAD_U32 = 144 /* TotalBuff */ - HEADER_TASK_LINE_U32;
var HEADER_TASK_OFFSET_IN_SLOT_U32 = HEADER_STATIC_PAYLOAD_U32;
var HEADER_U32_LENGTH = 0 /* header */ + HEADER_SLOT_STRIDE_U32 * 32 /* slots */;
var HEADER_BYTE_LENGTH = HEADER_U32_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
var INDEX_ID = 0;
var def = (_) => {};
var createTaskShell = () => {
  const task = new Uint32Array(8 /* Size */);
  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};
var makeTask = () => {
  const task = createTaskShell();
  task[1 /* ID */] = INDEX_ID++;
  return task;
};
var fillTaskFrom = (task, array, at) => {
  task[0] = array[at];
  task[1] = array[at + 1];
  task[2] = array[at + 2];
  task[3] = array[at + 3];
  task[4] = array[at + 4];
  task[5] = array[at + 5];
  task[6] = array[at + 6];
};
var makeTaskFrom = (array, at) => {
  const task = createTaskShell();
  fillTaskFrom(task, array, at);
  return task;
};
var settleTask = (task) => {
  if (task[0 /* FlagsToHost */] === 0) {
    task.resolve(task.value);
  } else {
    task.reject(task.value);
    task[0 /* FlagsToHost */] = 0;
  }
};
var lock2 = ({
  headers,
  headerSlotStrideU32,
  LockBoundSector,
  payload,
  payloadConfig,
  payloadSector,
  textCompat,
  resultList,
  toSentList,
  recycleList
}) => {
  const lockSectorRegion = toSharedBufferRegion(LockBoundSector ?? createWasmSharedArrayBuffer(LOCK_SECTOR_BYTE_LENGTH));
  const LockBoundSAB = lockSectorRegion.sab;
  const hostBits = new Int32Array(LockBoundSAB, lockSectorRegion.byteOffset + LOCK_HOST_BITS_OFFSET_BYTES, 1);
  const workerBits = new Int32Array(LockBoundSAB, lockSectorRegion.byteOffset + LOCK_WORKER_BITS_OFFSET_BYTES, 1);
  const headersRegion = toSharedBufferRegion(headers ?? createWasmSharedArrayBuffer(HEADER_BYTE_LENGTH));
  const headersBuffer = new Uint32Array(headersRegion.sab, headersRegion.byteOffset, headersRegion.byteLength >>> 2);
  const headersSlotStride = headerSlotStrideU32 ?? HEADER_SLOT_STRIDE_U32;
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    sab: payload,
    options: payloadConfig
  });
  const payloadSAB = payload ?? (resolvedPayloadConfig.mode === "growable" ? createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes, resolvedPayloadConfig.payloadMaxByteLength) : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes));
  const payloadLockRegion = toSharedBufferRegion(payloadSector ?? lockSectorRegion);
  const resolvedTextCompat = textCompat ?? probeLockBufferTextCompat({
    headers: headersRegion,
    payload: payloadSAB
  });
  let promiseHandler;
  let trackedDeferredTasks = new WeakSet;
  const encodeTask = encodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig
    },
    headersBuffer,
    headerSlotStrideU32: headersSlotStride,
    lockSector: payloadLockRegion,
    textCompat: resolvedTextCompat,
    onPromise: (task, isRejected, value) => {
      if (trackedDeferredTasks.delete(task) && pendingPromiseCount > 0) {
        pendingPromiseCount = pendingPromiseCount - 1 | 0;
      }
      promiseHandler(task, isRejected, value);
    }
  });
  const decodeTask = decodePayload({
    payload: {
      sab: payloadSAB,
      config: resolvedPayloadConfig
    },
    headersBuffer,
    headerSlotStrideU32: headersSlotStride,
    lockSector: payloadLockRegion,
    textCompat: resolvedTextCompat
  });
  let LastLocal = 0 | 0;
  let LastWorker = 0 | 0;
  let lastTake = 32 | 0;
  const toBeSent = toSentList ?? new RingQueue;
  const recyclecList = recycleList ?? new RingQueue;
  const resolved = resultList ?? new RingQueue;
  let deferredCount = 0 | 0;
  let pendingPromiseCount = 0 | 0;
  const a_load = Atomics.load;
  const a_store = Atomics.store;
  const toBeSentPush = (task) => toBeSent.push(task);
  const toBeSentShift = () => toBeSent.shiftNoClear();
  const toBeSentUnshift = (task) => toBeSent.unshift(task);
  const recycleShift = () => recyclecList.shiftNoClear();
  const resolvedPush = (task) => resolved.push(task);
  const clz32 = Math.clz32;
  const slotOffset = (at) => getStridedSlotOffsetU32({
    slotIndex: at,
    slotStrideU32: headersSlotStride,
    baseU32: 0 /* header */,
    extraU32: HEADER_TASK_OFFSET_IN_SLOT_U32
  });
  const takeTask = ({ queue }) => (at) => {
    const off = slotOffset(at);
    const task = queue[headersBuffer[off + 1 /* ID */]];
    fillTaskFrom(task, headersBuffer, off);
    return task;
  };
  const enlist = (task) => toBeSentPush(task);
  const trackDeferredTask = (task) => {
    if (trackedDeferredTasks.has(task))
      return;
    trackedDeferredTasks.add(task);
    pendingPromiseCount = pendingPromiseCount + 1 | 0;
  };
  let selectedSlotIndex = 0 | 0, selectedSlotBit = 0 >>> 0;
  const encodeWithState = (task, state) => {
    const free = ~state;
    if (free === 0)
      return 0;
    if (!encodeTask(task, selectedSlotIndex = 31 - clz32(free)))
      return 0;
    encodeAt(task, selectedSlotIndex, selectedSlotBit = 1 << selectedSlotIndex);
    return selectedSlotBit;
  };
  const encodeManyFrom = (list, trackDeferreds = false) => {
    let state = LastLocal ^ a_load(workerBits, 0) | 0;
    let encoded = 0 | 0;
    deferredCount = 0 | 0;
    if (list === toBeSent) {
      while (true) {
        const task = toBeSentShift();
        if (!task)
          break;
        const bit = encodeWithState(task, state) | 0;
        if (bit === 0) {
          if (isPromisePayloadPending(task)) {
            deferredCount = deferredCount + 1 | 0;
            if (trackDeferreds)
              trackDeferredTask(task);
            continue;
          }
          toBeSentUnshift(task);
          break;
        }
        state = state ^ bit | 0;
        encoded = encoded + 1 | 0;
      }
    } else {
      while (true) {
        const task = list.shiftNoClear();
        if (!task)
          break;
        const bit = encodeWithState(task, state) | 0;
        if (bit === 0) {
          if (isPromisePayloadPending(task)) {
            deferredCount = deferredCount + 1 | 0;
            if (trackDeferreds)
              trackDeferredTask(task);
            continue;
          }
          list.unshift(task);
          break;
        }
        state = state ^ bit | 0;
        encoded = encoded + 1 | 0;
      }
    }
    return encoded;
  };
  const encodeAll = () => {
    if (toBeSent.isEmpty)
      return true;
    encodeManyFrom(toBeSent, true);
    deferredCount = 0 | 0;
    return toBeSent.isEmpty;
  };
  const storeHost = (bit) => a_store(hostBits, 0, LastLocal = LastLocal ^ bit | 0);
  const storeWorker = (bit) => a_store(workerBits, 0, LastWorker = LastWorker ^ bit | 0);
  const encode = (task, state = LastLocal ^ a_load(workerBits, 0) | 0, trackDeferreds = false) => {
    deferredCount = 0 | 0;
    const free = ~state;
    if (free === 0)
      return false;
    if (!encodeTask(task, selectedSlotIndex = 31 - clz32(free))) {
      if (isPromisePayloadPending(task)) {
        deferredCount = 1;
        if (trackDeferreds)
          trackDeferredTask(task);
      }
      return false;
    }
    return encodeAt(task, selectedSlotIndex, selectedSlotBit = 1 << selectedSlotIndex);
  };
  const encodeAt = (task, at, bit) => {
    const off = slotOffset(at);
    headersBuffer[off] = task[0];
    headersBuffer[off + 1] = task[1];
    headersBuffer[off + 2] = task[2];
    headersBuffer[off + 3] = task[3];
    headersBuffer[off + 4] = task[4];
    headersBuffer[off + 5] = task[5];
    headersBuffer[off + 6] = task[6];
    headersBuffer[off + 7] = task[7];
    storeHost(bit);
    return true;
  };
  const hasSpace = () => (hostBits[0] ^ LastWorker) !== 0;
  const decode = () => {
    let diff = a_load(hostBits, 0) ^ LastWorker | 0;
    if (diff === 0)
      return false;
    let last = lastTake;
    let consumedBits = 0 | 0;
    try {
      if (last === 32) {
        decodeAt(selectedSlotIndex = 31 - clz32(diff));
        selectedSlotBit = 1 << (last = selectedSlotIndex);
        diff ^= selectedSlotBit;
        consumedBits = consumedBits ^ selectedSlotBit | 0;
      }
      while (diff !== 0) {
        let pick = diff & (1 << last) - 1;
        if (pick === 0)
          pick = diff;
        decodeAt(selectedSlotIndex = 31 - clz32(pick));
        selectedSlotBit = 1 << (last = selectedSlotIndex);
        diff ^= selectedSlotBit;
        consumedBits = consumedBits ^ selectedSlotBit | 0;
      }
    } finally {
      if (consumedBits !== 0)
        storeWorker(consumedBits);
    }
    lastTake = last;
    return true;
  };
  const resolveHost = ({
    queue,
    onResolved,
    shouldSettle
  }) => {
    const getTask = takeTask({ queue });
    const HAS_RESOLVE = onResolved ? true : false;
    const HAS_SHOULD_SETTLE = shouldSettle ? true : false;
    let lastResolved = 32;
    return () => {
      let diff = a_load(hostBits, 0) ^ LastWorker | 0;
      if (diff === 0)
        return 0;
      let modified = 0;
      let consumedBits = 0 | 0;
      let last = lastResolved;
      if (last === 32) {
        const idx = 31 - clz32(diff);
        const selectedBit = 1 << idx;
        const task = getTask(idx);
        decodeTask(task, idx);
        consumedBits = consumedBits ^ selectedBit | 0;
        const CAN_SETTLE = !HAS_SHOULD_SETTLE || shouldSettle(task);
        if (CAN_SETTLE) {
          settleTask(task);
        }
        if (CAN_SETTLE && HAS_RESOLVE) {
          onResolved(task);
        }
        diff ^= selectedBit;
        modified++;
        if ((modified & 7) === 0 && consumedBits !== 0) {
          LastWorker = LastWorker ^ consumedBits | 0;
          a_store(workerBits, 0, LastWorker);
          consumedBits = 0 | 0;
        }
        last = idx;
      }
      while (diff !== 0) {
        const lowerMask = last === 31 ? 2147483647 : (1 << last) - 1;
        let pick = diff & lowerMask;
        if (pick === 0)
          pick = diff;
        const idx = 31 - clz32(pick);
        const selectedBit = 1 << idx;
        const task = getTask(idx);
        decodeTask(task, idx);
        consumedBits = consumedBits ^ selectedBit | 0;
        const CAN_SETTLE = !HAS_SHOULD_SETTLE || shouldSettle(task);
        if (CAN_SETTLE) {
          settleTask(task);
        }
        if (CAN_SETTLE && HAS_RESOLVE) {
          onResolved(task);
        }
        diff ^= selectedBit;
        modified++;
        if ((modified & 7) === 0 && consumedBits !== 0) {
          LastWorker = LastWorker ^ consumedBits | 0;
          a_store(workerBits, 0, LastWorker);
          consumedBits = 0 | 0;
        }
        last = idx;
      }
      if (consumedBits !== 0) {
        LastWorker = LastWorker ^ consumedBits | 0;
        a_store(workerBits, 0, LastWorker);
      }
      lastResolved = last;
      return modified;
    };
  };
  const decodeAt = (at) => {
    const off = slotOffset(at);
    const recycled = recycleShift();
    let task;
    if (recycled) {
      fillTaskFrom(recycled, headersBuffer, off);
      recycled.value = null;
      recycled.resolve = def;
      recycled.reject = def;
      task = recycled;
    } else {
      task = makeTaskFrom(headersBuffer, off);
    }
    decodeTask(task, at);
    resolvedPush(task);
    return true;
  };
  const publish = (task) => {
    if (encode(task, undefined, true))
      return true;
    if ((deferredCount | 0) !== 0) {
      deferredCount = 0 | 0;
      return false;
    }
    toBeSentPush(task);
    return false;
  };
  const flushPending = () => {
    if (toBeSent.isEmpty)
      return false;
    const encoded = encodeManyFrom(toBeSent, true) | 0;
    deferredCount = 0 | 0;
    return encoded !== 0;
  };
  const resetPendingState = () => {
    toBeSent.clear();
    deferredCount = 0 | 0;
    pendingPromiseCount = 0 | 0;
    trackedDeferredTasks = new WeakSet;
  };
  return {
    enlist,
    encode,
    encodeManyFrom,
    encodeAll,
    publish,
    flushPending,
    decode,
    hasSpace,
    resolved,
    hostBits,
    workerBits,
    recyclecList,
    resolveHost,
    hasPendingFrames: () => toBeSent.size !== 0,
    getPendingFrameCount: () => toBeSent.size | 0,
    getPendingPromiseCount: () => pendingPromiseCount | 0,
    resetPendingState,
    takeDeferredCount: () => {
      const count = deferredCount | 0;
      deferredCount = 0 | 0;
      return count;
    },
    setPromiseHandler: (handler) => {
      promiseHandler = handler;
    }
  };
};

// src/worker/composable-runners.ts
var ABORT_SIGNAL_META_OFFSET = 1;
var TIMEOUT_KIND_RESOLVE = 1;
var p_now = performance.now.bind(performance);
var raceTimeout = (promise, ms, resolveOnTimeout, timeoutValue) => new Promise((resolve, reject) => {
  let done = false;
  const timer = setTimeout(() => {
    if (done)
      return;
    done = true;
    if (resolveOnTimeout)
      resolve(timeoutValue);
    else
      reject(timeoutValue);
  }, ms);
  promise.then((value) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    resolve(value);
  }, (err) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    reject(err);
  });
});
var nowStamp = (now) => (Math.floor(now()) & TASK_SLOT_META_VALUE_MASK) >>> 0;
var applyTimeoutBudget = (promise, slot, spec, now) => {
  const elapsed = nowStamp(now) - getTaskSlotMeta(slot) & TASK_SLOT_META_VALUE_MASK;
  const remaining = spec.ms - elapsed;
  if (!(remaining > 0)) {
    promise.then(() => {}, () => {});
    return spec.kind === TIMEOUT_KIND_RESOLVE ? Promise.resolve(spec.value) : Promise.reject(spec.value);
  }
  const timeoutMs = Math.max(1, Math.floor(remaining));
  return raceTimeout(promise, timeoutMs, spec.kind === TIMEOUT_KIND_RESOLVE, spec.value);
};
var NO_ABORT_SIGNAL = -1;
var readSignal = (slot) => {
  const encodedSignal = getTaskFunctionMeta(slot);
  if (encodedSignal === 0)
    return NO_ABORT_SIGNAL;
  const signal = encodedSignal - ABORT_SIGNAL_META_OFFSET | 0;
  return signal >= 0 ? signal : NO_ABORT_SIGNAL;
};
var throwIfAborted = (signal, hasAborted) => {
  if (signal === NO_ABORT_SIGNAL)
    return;
  if (hasAborted(signal))
    throw new Error("Task aborted");
};
var makeToolkitCache = (hasAborted) => {
  const bySignal = [];
  return (signal) => {
    let toolkit = bySignal[signal];
    if (toolkit)
      return toolkit;
    const hasAbortedMethod = () => hasAborted(signal);
    toolkit = {
      hasAborted: hasAbortedMethod
    };
    bySignal[signal] = toolkit;
    return toolkit;
  };
};
var composeWorkerRunner = ({
  job,
  timeout,
  hasAborted,
  now
}) => {
  const nowTime = now ?? p_now;
  if (!hasAborted) {
    if (!timeout) {
      return (slot) => job(slot.value);
    }
    return (slot) => {
      const result = job(slot.value);
      if (!(result instanceof Promise))
        return result;
      return applyTimeoutBudget(result, slot, timeout, nowTime);
    };
  }
  const getToolkit = makeToolkitCache(hasAborted);
  if (!timeout) {
    return (slot) => {
      const signal = readSignal(slot);
      throwIfAborted(signal, hasAborted);
      if (signal === NO_ABORT_SIGNAL)
        return job(slot.value);
      return job(slot.value, getToolkit(signal));
    };
  }
  return (slot) => {
    const signal = readSignal(slot);
    throwIfAborted(signal, hasAborted);
    const result = signal === NO_ABORT_SIGNAL ? job(slot.value) : job(slot.value, getToolkit(signal));
    if (!(result instanceof Promise))
      return result;
    return applyTimeoutBudget(result, slot, timeout, nowTime);
  };
};

// src/worker/rx-queue.ts
var createWorkerRxQueue = ({
  listOfFunctions,
  workerOptions,
  lock,
  returnLock,
  hasAborted,
  now
}) => {
  const PLACE_HOLDER = (_) => {
    throw "UNREACHABLE FROM PLACE HOLDER (thread)";
  };
  let hasAnythingFinished = 0;
  let awaiting = 0;
  const jobs = listOfFunctions.reduce((acc, fixed) => (acc.push(fixed.run), acc), []);
  const toWork = new RingQueue;
  const pendingFrames = new RingQueue;
  const toWorkPush = (slot) => toWork.push(slot);
  const toWorkShift = () => toWork.shiftNoClear();
  const pendingShift = () => pendingFrames.shiftNoClear();
  const pendingUnshift = (slot) => pendingFrames.unshift(slot);
  const pendingPush = (slot) => pendingFrames.push(slot);
  const recyclePush = (slot) => lock.recyclecList.push(slot);
  const FUNCTION_ID_MASK = 65535;
  const IDX_FLAGS = 0 /* FlagsToHost */;
  const FLAG_REJECT = 1 /* Reject */;
  const runByIndex = listOfFunctions.reduce((acc, fixed, idx) => {
    const job = jobs[idx];
    acc.push(composeWorkerRunner({
      job,
      timeout: fixed.timeout,
      hasAborted,
      now
    }));
    return acc;
  }, []);
  const hasCompleted = workerOptions?.resolveAfterFinishingAll === true ? () => hasAnythingFinished !== 0 && toWork.size === 0 : () => hasAnythingFinished !== 0;
  const { decode, resolved } = lock;
  const resolvedShift = resolved.shiftNoClear.bind(resolved);
  const enqueueLock = () => {
    if (!decode())
      return false;
    let task = resolvedShift();
    while (task) {
      task.resolve = PLACE_HOLDER;
      task.reject = PLACE_HOLDER;
      toWorkPush(task);
      task = resolvedShift();
    }
    return true;
  };
  const encodeReturnSafe = (slot) => {
    if (!returnLock.encode(slot))
      return false;
    return true;
  };
  const sendReturn = (slot, shouldReject) => {
    slot[IDX_FLAGS] = shouldReject ? FLAG_REJECT : 0;
    if (!encodeReturnSafe(slot))
      return false;
    hasAnythingFinished--;
    recyclePush(slot);
    return true;
  };
  const settleNow = (slot, isError, value, wasAwaited) => {
    slot.value = value;
    hasAnythingFinished++;
    if (wasAwaited && awaiting > 0)
      awaiting--;
    const shouldReject = isError || slot[IDX_FLAGS] === FLAG_REJECT;
    if (!sendReturn(slot, shouldReject))
      pendingPush(slot);
  };
  const writeOne = () => {
    const slot = pendingShift();
    if (!slot)
      return false;
    if (!sendReturn(slot, slot[IDX_FLAGS] === FLAG_REJECT)) {
      pendingUnshift(slot);
      return false;
    }
    return true;
  };
  return {
    hasCompleted,
    hasPending: () => toWork.size !== 0,
    writeBatch: (max) => {
      let wrote = 0;
      while (wrote < max) {
        if (!writeOne())
          break;
        wrote++;
      }
      return wrote;
    },
    serviceBatchImmediate: () => {
      let processed = 0;
      while (processed < 5 && toWork.size !== 0) {
        const slot = toWorkShift();
        try {
          const fnIndex = slot[0 /* FunctionID */] & FUNCTION_ID_MASK;
          const result = runByIndex[fnIndex](slot);
          slot[IDX_FLAGS] = 0;
          slot.value = null;
          if (result instanceof Promise) {
            awaiting++;
            result.then((value) => settleNow(slot, false, value, true), (err) => settleNow(slot, true, err, true));
          } else {
            settleNow(slot, false, result, false);
          }
        } catch (err) {
          settleNow(slot, true, err, false);
        }
        ++processed;
      }
      return processed;
    },
    enqueueLock,
    hasAwaiting: () => awaiting > 0,
    getAwaiting: () => awaiting
  };
};

// src/ipc/transport/shared-memory.ts
var page2 = 1024 * 4;
var CACHE_LINE_BYTES = 64;
var SIGNAL_OFFSETS = {
  op: 0,
  rxStatus: CACHE_LINE_BYTES,
  txStatus: CACHE_LINE_BYTES * 2
};
var TRANSPORT_SIGNAL_BYTES = CACHE_LINE_BYTES * 3;
var a_store = Atomics.store;
var createSharedMemoryTransport = ({ sabObject, isMain, startTime }) => {
  const toGrow = sabObject?.size ?? page2;
  const roundedSize = toGrow + (page2 - toGrow % page2) % page2;
  const signalRegion = toSharedBufferRegion(sabObject?.sharedSab ? sabObject.sharedSab : createSharedArrayBuffer(roundedSize, page2 * page2));
  const sab = signalRegion.sab;
  const baseByteOffset = signalRegion.byteOffset;
  const startAt = startTime ?? performance.now();
  const opView = new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.op, 1);
  if (isMain)
    a_store(opView, 0, 0);
  const rxStatus = new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.rxStatus, 1);
  a_store(rxStatus, 0, 1);
  return {
    sab: signalRegion,
    op: opView,
    startAt,
    opView,
    rxStatus,
    txStatus: new Int32Array(sab, baseByteOffset + SIGNAL_OFFSETS.txStatus, 1)
  };
};

// src/common/task-symbol.ts
var endpointSymbol = Symbol.for("task");

// src/common/module-url.ts
var WINDOWS_DRIVE_PATH2 = /^[A-Za-z]:[\\/]/;
var WINDOWS_UNC_PATH2 = /^\\\\[^\\/?]+\\[^\\/?]+/;
var encodeFilePath2 = (path) => encodeURI(path).replace(/\?/g, "%3F").replace(/#/g, "%23");
var toModuleUrl = (specifier) => {
  if (WINDOWS_DRIVE_PATH2.test(specifier)) {
    const normalized = specifier.replace(/\\/g, "/");
    return `file:///${encodeFilePath2(normalized)}`;
  }
  if (WINDOWS_UNC_PATH2.test(specifier)) {
    const normalized = specifier.replace(/^\\\\+/, "").replace(/\\/g, "/");
    return `file://${encodeFilePath2(normalized)}`;
  }
  try {
    return new URL(specifier).href;
  } catch {
    return pathToFileURLCompat(specifier).href;
  }
};

// src/worker/get-functions.ts
var normalizeTimeout = (timeout) => {
  if (timeout == null)
    return;
  if (typeof timeout === "number") {
    const ms2 = Math.floor(timeout);
    return ms2 >= 0 ? { ms: ms2, kind: 0 /* Reject */, value: new Error("Task timeout") } : undefined;
  }
  const ms = Math.floor(timeout.time);
  if (!(ms >= 0))
    return;
  if ("default" in timeout) {
    return { ms, kind: 1 /* Resolve */, value: timeout.default };
  }
  if (timeout.maybe === true) {
    return { ms, kind: 1 /* Resolve */, value: undefined };
  }
  if ("error" in timeout) {
    return { ms, kind: 0 /* Reject */, value: timeout.error };
  }
  return { ms, kind: 0 /* Reject */, value: new Error("Task timeout") };
};
var composeWorkerCallable = (fixed, _permission) => {
  return fixed.f;
};
var getFunctions = async ({ list, ids, at, permission }) => {
  const modules = list.map((specifier) => toModuleUrl(specifier));
  const results = await Promise.all(modules.map(async (imports) => {
    const module = await import(imports);
    return Object.entries(module).filter(([_, value]) => value != null && typeof value === "object" && value?.[endpointSymbol] === true).map(([name, value]) => ({
      ...value,
      name
    }));
  }));
  const flattened = results.flat();
  const useAtFilter = modules.length === 1 && at.length > 0;
  const atSet = useAtFilter ? new Set(at) : null;
  const targetModule = useAtFilter ? modules[0] : null;
  const flattenedResults = flattened.filter((obj) => useAtFilter ? obj.importedFrom === targetModule && atSet.has(obj.at) : ids.includes(obj.id)).sort((a, b) => a.name.localeCompare(b.name));
  return flattenedResults.map((fixed) => ({
    ...fixed,
    run: composeWorkerCallable(fixed, permission),
    timeout: normalizeTimeout(fixed.timeout)
  }));
};

// src/worker/timers.ts
var maybeGc = (() => {
  const host = globalThis;
  const gc = typeof host.gc === "function" ? host.gc.bind(globalThis) : undefined;
  if (gc) {
    try {
      delete host.gc;
    } catch {
      host.gc = undefined;
    }
    if (host.global) {
      try {
        delete host.global.gc;
      } catch {
        host.global.gc = undefined;
      }
    }
  }
  return gc ?? (() => {});
})();
var DEFAULT_PAUSE_TIME = 250;
var a_load = Atomics.load;
var a_store2 = Atomics.store;
var a_wait = typeof Atomics.wait === "function" ? Atomics.wait : undefined;
var p_now2 = performance.now.bind(performance);
var a_pause = "pause" in Atomics ? Atomics.pause : undefined;
var whilePausing = ({ pauseInNanoseconds }) => {
  const forNanoseconds = pauseInNanoseconds ?? DEFAULT_PAUSE_TIME;
  if (!a_pause || forNanoseconds <= 0)
    return () => {};
  return () => a_pause(forNanoseconds);
};
var pauseGeneric = whilePausing({});
var sleepUntilChanged = ({
  at,
  opView,
  pauseInNanoseconds,
  rxStatus,
  txStatus,
  enqueueLock,
  write
}) => {
  const pause = pauseInNanoseconds !== undefined ? whilePausing({ pauseInNanoseconds }) : pauseGeneric;
  const tryProgress = () => {
    let progressed = false;
    if (enqueueLock())
      progressed = true;
    if (write) {
      const wrote = write();
      if (typeof wrote === "number") {
        if (wrote > 0)
          progressed = true;
      } else if (wrote === true) {
        progressed = true;
      }
    }
    return progressed;
  };
  return (value, spinMicroseconds, parkMs) => {
    const until = p_now2() + spinMicroseconds / 1000;
    maybeGc();
    let spinChecks = 0;
    while (true) {
      if (a_load(opView, at) !== value || txStatus[0 /* thisIsAHint */] === 1)
        return;
      if (tryProgress())
        return;
      pause();
      if ((spinChecks++ & 63) === 0 && p_now2() >= until)
        break;
    }
    if (tryProgress())
      return;
    a_store2(rxStatus, 0, 0);
    a_wait(opView, at, value, parkMs ?? 60);
    a_store2(rxStatus, 0, 1);
  };
};

// src/worker/safety/process.ts
var toErrorMessage = (error) => error instanceof Error ? error.message : String(error);
var failProcessGuardInstall = (target, reason, cause) => {
  const suffix = cause === undefined ? "" : `: ${toErrorMessage(cause)}`;
  throw new Error(`KNT_ERROR_PROCESS_GUARD_INSTALL: ${target} ${reason}${suffix}`);
};
var installTerminationGuard = () => {
  if (typeof process === "undefined")
    return;
  const proc = process;
  if (proc.__knittingTerminationGuard === true)
    return;
  const blocked = (name) => {
    throw new Error(`KNT_ERROR_PROCESS_GUARD: ${name} is disabled in worker tasks`);
  };
  const guardMethod = (name) => {
    try {
      Object.defineProperty(proc, name, {
        configurable: false,
        writable: false,
        value: (..._args) => blocked(`process.${name}`)
      });
    } catch (defineError) {
      try {
        proc[name] = (..._args) => blocked(`process.${name}`);
      } catch (assignError) {
        failProcessGuardInstall(`process.${name}`, "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError)
        ].join("; "));
      }
    }
    if (typeof proc[name] !== "function") {
      failProcessGuardInstall(`process.${name}`, "install verification failed");
    }
  };
  guardMethod("exit");
  guardMethod("kill");
  guardMethod("abort");
  guardMethod("reallyExit");
  const globalScope = globalThis;
  if (globalScope.Deno && typeof globalScope.Deno.exit === "function") {
    try {
      Object.defineProperty(globalScope.Deno, "exit", {
        configurable: false,
        writable: false,
        value: (_code) => blocked("Deno.exit")
      });
    } catch (defineError) {
      try {
        globalScope.Deno.exit = (_code) => blocked("Deno.exit");
      } catch (assignError) {
        failProcessGuardInstall("Deno.exit", "install failed", [
          toErrorMessage(defineError),
          toErrorMessage(assignError)
        ].join("; "));
      }
    }
    if (typeof globalScope.Deno.exit !== "function") {
      failProcessGuardInstall("Deno.exit", "install verification failed");
    }
  }
  proc.__knittingTerminationGuard = true;
};
var installUnhandledRejectionSilencer = () => {
  if (typeof process === "undefined" || typeof process.on !== "function") {
    return;
  }
  const proc = process;
  if (proc.__knittingUnhandledRejectionSilencer === true)
    return;
  proc.__knittingUnhandledRejectionSilencer = true;
  process.on("unhandledRejection", () => {});
};
// src/worker/safety/performance.ts
var installPerformanceNowGuard = () => {
  const g = globalThis;
  if (g.__knittingPerformanceNowGuardInstalled === true)
    return;
  g.__knittingPerformanceNowGuardInstalled = true;
  const perf = globalThis.performance;
  if (!perf || typeof perf.now !== "function")
    return;
  try {
    perf.now();
  } catch {}
};
// src/worker/safety/worker-data.ts
var scrubWorkerDataSensitiveBuffers = (value) => {
  const data = value;
  try {
    data.sab = undefined;
    data.lock = undefined;
    data.returnLock = undefined;
    data.permission = undefined;
  } catch {}
  try {
    delete data.sab;
  } catch {}
  try {
    delete data.lock;
  } catch {}
  try {
    delete data.returnLock;
  } catch {}
  try {
    delete data.permission;
  } catch {}
  try {
    Object.freeze(data);
  } catch {}
};
// src/worker/safety/startup.ts
var hasLockBuffers = (value) => isSharedBufferSource(value?.headers) && isSharedBufferSource(value?.lockSector) && value?.payload instanceof SharedArrayBuffer && isSharedBufferSource(value?.payloadSector) && (value?.textCompat === undefined || isLockBufferTextCompat(value.textCompat));
var assertWorkerSharedMemoryBootData = ({ sab, lock, returnLock }) => {
  if (!isSharedBufferSource(sab)) {
    throw new Error("worker missing transport SAB");
  }
  if (!hasLockBuffers(lock)) {
    throw new Error("worker missing lock SABs");
  }
  if (!hasLockBuffers(returnLock)) {
    throw new Error("worker missing return lock SABs");
  }
};
var assertWorkerImportsResolved = ({ debug, list, ids, listOfFunctions }) => {
  if (debug?.logImportedUrl === true) {
    console.log(list);
  }
  if (listOfFunctions.length > 0)
    return;
  console.log(list);
  console.log(ids);
  console.log(listOfFunctions);
  throw new Error("No imports were found.");
};
// src/shared/abortSignal.ts
var SLOT_BITS = 32;
var SLOT_MASK = SLOT_BITS - 1;
var AbortSignalPoolExhausted = Symbol.for("knitting.abortSignal.poolExhausted");
var EnqueuedAbortSignal = Symbol.for("knitting.abortSignal.enqueuedSignal");
var signalAbortFactory = ({
  sab,
  maxSignals
}) => {
  const sabRegion = toSharedBufferRegion(sab);
  const atomicView = new Uint32Array(sabRegion.sab, sabRegion.byteOffset, sabRegion.byteLength / Uint32Array.BYTES_PER_ELEMENT);
  const size = atomicView.length;
  const inUse = new Uint32Array(size);
  const physicalMax = size * SLOT_BITS;
  const max = (() => {
    if (!Number.isFinite(maxSignals))
      return physicalMax;
    const parsed = Math.floor(maxSignals);
    if (parsed <= 0)
      return physicalMax;
    return Math.min(parsed, physicalMax);
  })();
  const closeNow = max + 1;
  let current = 0;
  let cursor = 0;
  const getSignal = () => {
    if (current >= max)
      return closeNow;
    for (let step = 0;step < size; step++) {
      const word = (cursor + step) % size;
      const wordBase = word << 5;
      const remaining = max - wordBase;
      if (remaining <= 0)
        continue;
      const allowedMask = remaining >= SLOT_BITS ? 4294967295 : (1 << remaining) - 1 >>> 0;
      const freeBits = (~inUse[word] & allowedMask) >>> 0;
      if (freeBits === 0)
        continue;
      const bit = (freeBits & -freeBits) >>> 0;
      inUse[word] = (inUse[word] | bit) >>> 0;
      current = current + 1 | 0;
      cursor = (word + 1) % size;
      Atomics.and(atomicView, word, ~bit);
      const bitIndex = 31 - Math.clz32(bit);
      return (word << 5) + bitIndex;
    }
    return closeNow;
  };
  const setSignal = (signal) => {
    if (signal === closeNow)
      return 0;
    if (!Number.isInteger(signal))
      return -1;
    if (signal < 0 || signal >= max)
      return -1;
    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    Atomics.or(atomicView, word, bit);
    return 1;
  };
  const abortAll = () => {
    for (let word = 0;word < size; word++) {
      Atomics.store(atomicView, word, inUse[word]);
    }
    return current;
  };
  const hasAborted = (signal) => {
    if (signal === closeNow)
      return true;
    if (!Number.isInteger(signal))
      return false;
    if (signal < 0 || signal >= max)
      return false;
    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    return (Atomics.load(atomicView, word) & bit) !== 0;
  };
  const resetSignal = (signal) => {
    if (signal === closeNow)
      return false;
    if (!Number.isInteger(signal))
      return false;
    if (signal < 0 || signal >= max)
      return false;
    const word = signal >>> 5;
    const bit = 1 << (signal & SLOT_MASK);
    const used = (inUse[word] & bit) !== 0;
    if (!used)
      return false;
    inUse[word] = (inUse[word] & ~bit) >>> 0;
    if (current > 0)
      current = current - 1 | 0;
    cursor = word;
    Atomics.and(atomicView, word, ~bit);
    return true;
  };
  return {
    max,
    closeNow,
    getSignal,
    setSignal,
    abortAll,
    hasAborted,
    resetSignal,
    inUseCount: () => current
  };
};

class OneShotDeferred {
  #triggered = false;
  constructor(deferred, onSettle) {
    const settleOnce = (fn) => (...args) => {
      if (this.#triggered)
        return;
      this.#triggered = true;
      onSettle();
      fn(...args);
    };
    deferred.resolve = settleOnce(deferred.resolve);
    deferred.reject = settleOnce(deferred.reject);
    deferred.promise.reject = deferred.reject;
  }
}

// src/worker/loop.ts
var jsrIsGreatAndWorkWithoutBugs = () => null;
var WORKER_FATAL_MESSAGE_KEY = "__knittingWorkerFatal";
var reportWorkerStartupFatal = (error) => {
  const message = String(error?.message ?? error);
  const payload = {
    [WORKER_FATAL_MESSAGE_KEY]: message
  };
  try {
    RUNTIME_PARENT_PORT?.postMessage?.(payload);
    return;
  } catch {}
  try {
    globalThis.postMessage(payload);
  } catch {}
};
var workerMainLoop = async (startupData) => {
  installTerminationGuard();
  installUnhandledRejectionSilencer();
  installPerformanceNowGuard();
  const {
    debug,
    sab,
    thread,
    startAt,
    workerOptions,
    lock,
    returnLock,
    abortSignalSAB,
    abortSignalMax,
    payloadConfig,
    permission,
    totalNumberOfThread,
    list,
    ids,
    at
  } = startupData;
  scrubWorkerDataSensitiveBuffers(startupData);
  assertWorkerSharedMemoryBootData({ sab, lock, returnLock });
  var Comment;
  ((Comment2) => {
    Comment2[Comment2["thisIsAHint"] = 0] = "thisIsAHint";
  })(Comment ||= {});
  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: sab
    },
    isMain: false,
    thread,
    debug,
    startTime: startAt
  });
  const lockState = lock2({
    headers: lock.headers,
    headerSlotStrideU32: lock.headerSlotStrideU32,
    LockBoundSector: lock.lockSector,
    payload: lock.payload,
    payloadSector: lock.payloadSector,
    payloadConfig,
    textCompat: lock.textCompat
  });
  const returnLockState = lock2({
    headers: returnLock.headers,
    headerSlotStrideU32: returnLock.headerSlotStrideU32,
    LockBoundSector: returnLock.lockSector,
    payload: returnLock.payload,
    payloadSector: returnLock.payloadSector,
    payloadConfig,
    textCompat: returnLock.textCompat
  });
  const timers = workerOptions?.timers;
  const spinMicroseconds = timers?.spinMicroseconds ?? Math.max(1, totalNumberOfThread) * 50;
  const parkMs = timers?.parkMs ?? Math.max(1, totalNumberOfThread) * 50;
  const pauseSpin = (() => {
    const fn = typeof timers?.pauseNanoseconds === "number" ? whilePausing({ pauseInNanoseconds: timers.pauseNanoseconds }) : pauseGeneric;
    return () => fn();
  })();
  const { opView, rxStatus, txStatus } = signals;
  const a_store3 = Atomics.store;
  const a_load2 = Atomics.load;
  const listOfFunctions = await getFunctions({
    list,
    isWorker: true,
    ids,
    at,
    permission
  });
  assertWorkerImportsResolved({ debug, list, ids, listOfFunctions });
  const abortSignals = abortSignalSAB ? signalAbortFactory({
    sab: abortSignalSAB,
    maxSignals: abortSignalMax
  }) : undefined;
  const {
    enqueueLock,
    serviceBatchImmediate,
    hasCompleted,
    writeBatch,
    hasPending,
    getAwaiting
  } = createWorkerRxQueue({
    listOfFunctions,
    workerOptions,
    lock: lockState,
    returnLock: returnLockState,
    hasAborted: abortSignals?.hasAborted
  });
  a_store3(rxStatus, 0, 1);
  const WRITE_MAX = 64;
  const pauseUntil = sleepUntilChanged({
    opView,
    at: 0,
    rxStatus,
    txStatus,
    pauseInNanoseconds: timers?.pauseNanoseconds,
    enqueueLock,
    write: () => hasCompleted() ? writeBatch(WRITE_MAX) : 0
  });
  const channel = createRuntimeMessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = port2.postMessage.bind(port2);
  let isInMacro = false;
  let awaitingSpins = 0;
  let lastAwaiting = 0;
  const MAX_AWAITING_MS = 10;
  let wakeSeq = a_load2(opView, 0);
  const scheduleMacro = () => {
    if (isInMacro)
      return;
    isInMacro = true;
    post2(null);
  };
  const scheduleTimer = (delayMs) => {
    if (isInMacro)
      return;
    isInMacro = true;
    if (delayMs <= 0 && typeof SET_IMMEDIATE === "function") {
      SET_IMMEDIATE(loop);
      return;
    }
    if (delayMs <= 0) {
      post2(null);
      return;
    }
    if (typeof setTimeout === "function") {
      setTimeout(loop, delayMs);
      return;
    }
    post2(null);
  };
  const _enqueueLock = enqueueLock;
  const _hasCompleted = hasCompleted;
  const _writeBatch = writeBatch;
  const _hasPending = hasPending;
  const _serviceBatchImmediate = serviceBatchImmediate;
  const _getAwaiting = getAwaiting;
  const _pauseSpin = pauseSpin;
  const _pauseUntil = pauseUntil;
  const loop = () => {
    isInMacro = false;
    let progressed = true;
    let awaiting = 0;
    while (true) {
      progressed = _enqueueLock();
      if (_hasCompleted()) {
        if (_writeBatch(WRITE_MAX) > 0)
          progressed = true;
      }
      if (_hasPending()) {
        if (_serviceBatchImmediate() > 0)
          progressed = true;
      }
      if ((awaiting = _getAwaiting()) > 0) {
        if (awaiting !== lastAwaiting)
          awaitingSpins = 0;
        lastAwaiting = awaiting;
        awaitingSpins++;
        const delay = Math.min(MAX_AWAITING_MS, Math.max(0, awaitingSpins - 1));
        scheduleTimer(delay);
        return;
      }
      awaitingSpins = lastAwaiting = 0;
      if (!progressed) {
        if (txStatus[0 /* thisIsAHint */] === 1) {
          _pauseSpin();
          continue;
        }
        _pauseUntil(wakeSeq, spinMicroseconds, parkMs);
        wakeSeq = a_load2(opView, 0);
      }
    }
  };
  const port1Any = port1;
  if (typeof port1Any.on === "function") {
    port1Any.on("message", loop);
  } else {
    port1Any.onmessage = loop;
  }
  port1Any.start?.();
  port2.start?.();
  scheduleMacro();
};
var isWebWorkerScope2 = () => {
  const scopeCtor = globalThis.WorkerGlobalScope;
  if (typeof scopeCtor !== "function")
    return false;
  try {
    return globalThis instanceof scopeCtor;
  } catch {
    return false;
  }
};
var isLockBuffers = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return isSharedBufferSource(candidate.headers) && isSharedBufferSource(candidate.lockSector) && candidate.payload instanceof SharedArrayBuffer && isSharedBufferSource(candidate.payloadSector) && (candidate.textCompat === undefined || isLockBufferTextCompat(candidate.textCompat));
};
var isWorkerBootPayload = (value) => {
  if (!value || typeof value !== "object")
    return false;
  const candidate = value;
  return isSharedBufferSource(candidate.sab) && Array.isArray(candidate.list) && Array.isArray(candidate.ids) && Array.isArray(candidate.at) && typeof candidate.thread === "number" && typeof candidate.totalNumberOfThread === "number" && typeof candidate.startAt === "number" && (candidate.abortSignalSAB === undefined || isSharedBufferSource(candidate.abortSignalSAB)) && isLockBuffers(candidate.lock) && isLockBuffers(candidate.returnLock);
};
var installWebWorkerBootstrap = () => {
  const g = globalThis;
  const start = (data) => {
    if (!isWorkerBootPayload(data))
      return;
    workerMainLoop(data).catch(reportWorkerStartupFatal);
  };
  if (typeof g.addEventListener === "function" && typeof g.removeEventListener === "function") {
    const onMessage = (event) => {
      const data = event?.data;
      if (!isWorkerBootPayload(data))
        return;
      try {
        g.removeEventListener?.("message", onMessage);
      } catch {}
      start(data);
    };
    g.addEventListener("message", onMessage);
    return;
  }
  g.onmessage = (event) => {
    const data = event?.data;
    if (!isWorkerBootPayload(data))
      return;
    g.onmessage = null;
    start(data);
  };
};
if (RUNTIME_IS_MAIN_THREAD === false && isWorkerBootPayload(RUNTIME_WORKER_DATA)) {
  workerMainLoop(RUNTIME_WORKER_DATA).catch(reportWorkerStartupFatal);
} else if (isWebWorkerScope2()) {
  installWebWorkerBootstrap();
}

// src/common/others.ts
var genTaskID = ((counter) => () => counter++)(0);
var INTERNAL_CALLER_HINTS = [
  "/src/common/others.ts",
  "\\src\\common\\others.ts",
  "/src/api.ts",
  "\\src\\api.ts"
];
var INTERNAL_CALLER_FUNCTIONS = new Set([
  "collectStackFrames",
  "resolveCallerHref",
  "getCallerFilePath",
  "buildTaskDefinition",
  "buildTaskDefinitionFromCaller",
  "task",
  "importTask"
]);
var isDefined = (value) => value !== undefined;
var looksLikeStackFile = (value) => value.startsWith("file:") || value.startsWith("http:") || value.startsWith("https:") || value.startsWith("blob:") || value.startsWith("webpack-internal:") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
var extractStackFile = (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0)
    return;
  const candidates = [
    trimmed.match(/\((.+?):\d+:\d+\)$/)?.[1],
    trimmed.match(/at (.+?):\d+:\d+$/)?.[1],
    trimmed.match(/^(?:.+@)?(.+?):\d+:\d+$/)?.[1]
  ];
  return candidates.find((value) => typeof value === "string" && looksLikeStackFile(value));
};
var isInternalCallerFrame = (file) => INTERNAL_CALLER_HINTS.some((hint) => file.includes(hint));
var isRuntimeInternalFrame = (file) => file.startsWith("node:") || file.startsWith("native:") || file.startsWith("bun:") || file.startsWith("internal/");
var isInternalCallerFunction = (functionName, methodName) => functionName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(functionName) || methodName !== undefined && INTERNAL_CALLER_FUNCTIONS.has(methodName);
var collectStackFrames = () => {
  const ErrorCtor = Error;
  const original = ErrorCtor.prepareStackTrace;
  try {
    ErrorCtor.prepareStackTrace = (_error, stack2) => stack2;
    const stack = new Error().stack;
    if (typeof stack === "string") {
      return stack.split(`
`).map((line) => {
        const file = extractStackFile(line);
        return file ? {
          file,
          functionName: undefined,
          methodName: undefined
        } : undefined;
      }).filter(isDefined);
    }
    if (!Array.isArray(stack))
      return [];
    const frames = stack.map((site) => {
      try {
        const file = site?.getFileName?.();
        if (typeof file !== "string" || file.length === 0)
          return;
        return {
          file,
          functionName: site?.getFunctionName?.() ?? undefined,
          methodName: site?.getMethodName?.() ?? undefined
        };
      } catch {
        return;
      }
    }).filter(isDefined);
    return frames;
  } finally {
    ErrorCtor.prepareStackTrace = original;
  }
};
var isInternalFrame = (frame) => isRuntimeInternalFrame(frame.file) || isInternalCallerFrame(frame.file) || isInternalCallerFunction(frame.functionName, frame.methodName);
var resolveCallerHref = (offset) => {
  const frames = collectStackFrames();
  const direct = frames[offset];
  const caller = (direct && !isInternalFrame(direct) ? direct.file : undefined) ?? frames.find((frame) => !isInternalFrame(frame))?.file ?? frames.find((frame) => !isRuntimeInternalFrame(frame.file))?.file;
  if (!caller) {
    throw new Error("Unable to determine caller file.");
  }
  return toModuleUrl(caller);
};
var linkingMap = new Map;
var getCallerFilePath = (offset = 3) => {
  const href = resolveCallerHref(offset);
  const at = linkingMap.get(href) ?? 0;
  linkingMap.set(href, at + 1);
  return [href, at];
};

// src/common/with-resolvers.ts
var withResolvers = () => {
  const native = Promise.withResolvers;
  if (typeof native === "function") {
    return native.call(Promise);
  }
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// src/runtime/tx-queue.ts
var SLOT_INDEX_MASK = 31;
var SLOT_META_MASK = 134217727;
var SLOT_META_SHIFT = 5;
var FUNCTION_ID_MASK = 65535;
var FUNCTION_META_MASK = 65535;
var FUNCTION_META_SHIFT = 16;
var ABORT_SIGNAL_META_OFFSET2 = 1;
var p_now3 = performance.now.bind(performance);
function createHostTxQueue({
  max,
  lock,
  returnLock,
  abortSignals,
  now
}) {
  const PLACE_HOLDER = (_) => {
    throw "UNREACHABLE FROM PLACE HOLDER (main)";
  };
  const newSlot = (id) => {
    const task = makeTask();
    task[1 /* ID */] = id;
    task[0 /* FunctionID */] = 0;
    task.value = null;
    task.resolve = PLACE_HOLDER;
    task.reject = PLACE_HOLDER;
    return task;
  };
  const initialSize = max ?? 10;
  const queue = Array.from({ length: initialSize }, (_, index) => newSlot(index));
  const freeSockets = Array.from({ length: initialSize }, (_, i) => i);
  const freePush = (id) => freeSockets.push(id);
  const freePop = () => freeSockets.pop();
  const queuePush = (task) => queue.push(task);
  const {
    publish,
    flushPending,
    hasPendingFrames,
    getPendingFrameCount,
    getPendingPromiseCount,
    resetPendingState
  } = lock;
  let inUsed = 0 | 0;
  const resetSignal = abortSignals?.resetSignal;
  const nowTime = now ?? p_now3;
  const resolveReturn = returnLock.resolveHost({
    queue,
    shouldSettle: (task) => task.reject !== PLACE_HOLDER,
    onResolved: (task) => {
      inUsed = inUsed - 1 | 0;
      task.value = null;
      task.resolve = PLACE_HOLDER;
      task.reject = PLACE_HOLDER;
      freePush(task[1 /* ID */]);
    }
  });
  const txIdle = () => getPendingFrameCount() === 0 && inUsed === getPendingPromiseCount();
  const rejectAll = (reason) => {
    for (let index = 0;index < queue.length; index++) {
      const slot = queue[index];
      if (slot.reject !== PLACE_HOLDER) {
        try {
          slot.reject(reason);
        } catch {}
        slot.resolve = PLACE_HOLDER;
        slot.reject = PLACE_HOLDER;
        queue[index] = newSlot(index);
      }
    }
    resetPendingState();
    inUsed = 0 | 0;
  };
  const flushToWorker = () => flushPending();
  const enqueueKnown = (task) => {
    return publish(task);
  };
  return {
    rejectAll,
    hasPendingFrames,
    txIdle,
    completeFrame: resolveReturn,
    enqueue: (functionID, timeout, abortSignal) => {
      const HAS_TIMER = timeout !== undefined;
      const functionIDMasked = functionID & FUNCTION_ID_MASK;
      const USE_SIGNAL = abortSignal !== undefined && abortSignals !== undefined;
      return (rawArgs) => {
        if (inUsed === queue.length) {
          const newSize = inUsed + 32;
          let current = queue.length;
          while (newSize > current) {
            queuePush(newSlot(current));
            freePush(current);
            current++;
          }
        }
        const index = freePop();
        const slot = queue[index];
        const deferred = withResolvers();
        slot[0 /* FunctionID */] = functionIDMasked;
        if (USE_SIGNAL) {
          const maybeSignal = abortSignals.getSignal();
          if (maybeSignal === abortSignals.closeNow) {
            return Promise.reject(AbortSignalPoolExhausted);
          }
          new OneShotDeferred(deferred, () => resetSignal(maybeSignal));
          const encodedSignalMeta = (maybeSignal + ABORT_SIGNAL_META_OFFSET2 & FUNCTION_META_MASK) >>> 0;
          slot[0 /* FunctionID */] = (encodedSignalMeta << FUNCTION_META_SHIFT | functionIDMasked) >>> 0;
        }
        slot.value = rawArgs;
        slot[1 /* ID */] = index;
        slot.resolve = deferred.resolve;
        slot.reject = deferred.reject;
        if (HAS_TIMER) {
          slot[6 /* slotBuffer */] = (slot[6 /* slotBuffer */] & SLOT_INDEX_MASK | (nowTime() >>> 0 & SLOT_META_MASK) << SLOT_META_SHIFT >>> 0) >>> 0;
        }
        publish(slot);
        inUsed = inUsed + 1 | 0;
        return deferred.promise;
      };
    },
    flushToWorker,
    enqueueKnown,
    settlePromisePayload: (task, isRejected, value) => {
      if (isRejected) {
        try {
          task.reject(value);
        } catch {}
        task.value = null;
        task.resolve = PLACE_HOLDER;
        task.reject = PLACE_HOLDER;
        inUsed = inUsed - 1 | 0;
        freePush(task[1 /* ID */]);
        return false;
      }
      task.value = value;
      return enqueueKnown(task);
    }
  };
}

// src/runtime/dispatcher.ts
var hostDispatcherLoop = ({
  signalBox: {
    opView,
    txStatus,
    rxStatus
  },
  queue: {
    completeFrame,
    hasPendingFrames,
    flushToWorker,
    txIdle
  },
  channelHandler,
  dispatcherOptions
}) => {
  const a_load2 = Atomics.load;
  const a_store3 = Atomics.store;
  const a_notify = Atomics.notify;
  const notify = channelHandler.notify.bind(channelHandler);
  let stallCount = 0 | 0;
  const STALL_FREE_LOOPS = Math.max(0, (dispatcherOptions?.stallFreeLoops ?? 128) | 0);
  const MAX_BACKOFF_MS = Math.max(0, (dispatcherOptions?.maxBackoffMs ?? 10) | 0);
  let backoffTimer;
  let inFlight = false;
  const check = () => {
    if (inFlight) {
      check.rerun = true;
      return;
    }
    inFlight = true;
    if (backoffTimer !== undefined) {
      clearTimeout(backoffTimer);
      backoffTimer = undefined;
    }
    do {
      check.rerun = false;
      txStatus[0] = 1;
      if (a_load2(rxStatus, 0) === 0) {
        a_store3(opView, 0, 1);
        a_notify(opView, 0, 1);
      }
      let anyProgressed = false;
      let progressed = true;
      while (progressed) {
        progressed = false;
        if (completeFrame() > 0) {
          progressed = true;
          anyProgressed = true;
        }
        while (hasPendingFrames()) {
          if (!flushToWorker())
            break;
          progressed = true;
          anyProgressed = true;
        }
      }
      txStatus[0] = 0;
      if (!txIdle()) {
        if (anyProgressed || hasPendingFrames()) {
          stallCount = 0 | 0;
        } else {
          stallCount = stallCount + 1 | 0;
        }
        inFlight = false;
        scheduleNotify();
        return;
      }
      stallCount = 0 | 0;
    } while (check.rerun);
    check.isRunning = false;
    inFlight = false;
  };
  check.isRunning = false;
  check.rerun = false;
  const scheduleNotify = () => {
    if (stallCount <= STALL_FREE_LOOPS) {
      notify();
      return;
    }
    if (backoffTimer !== undefined)
      return;
    let delay = stallCount - STALL_FREE_LOOPS - 1 | 0;
    if (delay < 0)
      delay = 0;
    else if (delay > MAX_BACKOFF_MS)
      delay = MAX_BACKOFF_MS;
    check.isRunning = false;
    backoffTimer = setTimeout(() => {
      backoffTimer = undefined;
      if (!check.isRunning) {
        check.isRunning = true;
        check();
      }
    }, delay);
  };
  return { check };
};

class ChannelHandler {
  channel;
  port1;
  port2;
  #post2;
  constructor() {
    this.channel = createRuntimeMessageChannel();
    this.port1 = this.channel.port1;
    this.port2 = this.channel.port2;
    this.#post2 = this.port2.postMessage.bind(this.port2);
  }
  notify() {
    this.#post2(null);
  }
  open(f) {
    const port1 = this.port1;
    if (typeof port1.on === "function") {
      port1.on("message", f);
    } else {
      port1.onmessage = f;
    }
    this.port1.start?.();
    this.port2.start?.();
  }
  close() {
    this.port1.onmessage = null;
    this.port2.onmessage = null;
    this.port1.close?.();
    this.port2.close?.();
  }
}

// src/runtime/pool.ts
var WORKER_FATAL_MESSAGE_KEY2 = "__knittingWorkerFatal";
var execFlagKey = (flag) => flag.split("=", 1)[0];
var NODE_PERMISSION_EXEC_FLAGS = new Set([
  "--permission",
  "--experimental-permission",
  "--allow-fs-read",
  "--allow-fs-write",
  "--allow-worker",
  "--allow-child-process",
  "--allow-addons",
  "--allow-wasi"
]);
var NODE_WORKER_SAFE_EXEC_FLAGS = new Set([
  "--experimental-transform-types",
  "--expose-gc",
  "--no-warnings",
  ...NODE_PERMISSION_EXEC_FLAGS
]);
var isWorkerFatalMessage = (value) => !!value && typeof value === "object" && typeof value[WORKER_FATAL_MESSAGE_KEY2] === "string";
var isNodeWorkerSafeExecFlag = (flag) => NODE_WORKER_SAFE_EXEC_FLAGS.has(execFlagKey(flag));
var isNodePermissionExecFlag = (flag) => NODE_PERMISSION_EXEC_FLAGS.has(execFlagKey(flag));
var toWorkerSafeExecArgv = (flags) => {
  if (!flags || flags.length === 0)
    return;
  const filtered = flags.filter(isNodeWorkerSafeExecFlag);
  if (filtered.length === 0)
    return;
  const seen = new Set;
  const deduped = [];
  for (const flag of filtered) {
    if (seen.has(flag))
      continue;
    seen.add(flag);
    deduped.push(flag);
  }
  return deduped;
};
var toWorkerCompatExecArgv = (flags) => {
  const safe = toWorkerSafeExecArgv(flags);
  if (!safe || safe.length === 0)
    return;
  const compat = safe.filter((flag) => !isNodePermissionExecFlag(flag));
  return compat.length > 0 ? compat : undefined;
};
var toPositiveInteger2 = (value) => {
  if (!Number.isFinite(value))
    return;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
};
var toNodeWorkerResourceLimits = (limits) => {
  if (!limits)
    return;
  const out = {
    maxOldGenerationSizeMb: toPositiveInteger2(limits.maxOldGenerationSizeMb),
    maxYoungGenerationSizeMb: toPositiveInteger2(limits.maxYoungGenerationSizeMb),
    codeRangeSizeMb: toPositiveInteger2(limits.codeRangeSizeMb),
    stackSizeMb: toPositiveInteger2(limits.stackSizeMb)
  };
  return Object.values(out).some((value) => value !== undefined) ? out : undefined;
};
var terminateWorkerQuietly = (worker) => {
  try {
    Promise.resolve(worker.terminate()).catch(() => {});
  } catch {}
};
var spawnWorkerContext = ({
  list,
  ids,
  sab,
  thread,
  debug,
  totalNumberOfThread,
  source,
  at,
  workerOptions,
  workerExecArgv,
  permission,
  host,
  payload,
  payloadInitialBytes,
  payloadMaxBytes,
  bufferMode,
  maxPayloadBytes,
  abortSignalCapacity,
  usesAbortSignal
}) => {
  const tsFileUrl = new URL(import.meta.url);
  const poliWorker = RUNTIME_WORKER;
  if (debug?.logHref === true) {
    console.log(tsFileUrl);
    jsrIsGreatAndWorkWithoutBugs();
  }
  if (typeof poliWorker !== "function") {
    throw new Error("Worker is not available in this runtime");
  }
  const sanitizeBytes = (value) => {
    if (!Number.isFinite(value))
      return;
    const bytes = Math.floor(value);
    return bytes > 0 ? bytes : undefined;
  };
  const resolvedPayloadConfig = resolvePayloadBufferOptions({
    options: {
      ...payload,
      mode: payload?.mode ?? bufferMode,
      maxPayloadBytes: payload?.maxPayloadBytes ?? maxPayloadBytes,
      payloadInitialBytes: payload?.payloadInitialBytes ?? sanitizeBytes(payloadInitialBytes),
      payloadMaxByteLength: payload?.payloadMaxByteLength ?? sanitizeBytes(payloadMaxBytes)
    }
  });
  const makePayloadBuffer = () => resolvedPayloadConfig.mode === "growable" ? createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes, resolvedPayloadConfig.payloadMaxByteLength) : createSharedArrayBuffer(resolvedPayloadConfig.payloadInitialBytes);
  const defaultAbortSignalCapacity = 258;
  const requestedAbortSignalCapacity = sanitizeBytes(abortSignalCapacity);
  const resolvedAbortSignalCapacity = requestedAbortSignalCapacity ?? defaultAbortSignalCapacity;
  const abortSignalWords = Math.max(1, Math.ceil(resolvedAbortSignalCapacity / 32));
  const requestedSignalBytes = sanitizeBytes(sab?.size);
  const externalSignalSab = sab?.sharedSab;
  const makeLockControlLayout = () => {
    const signalBytes = Math.max(TRANSPORT_SIGNAL_BYTES, requestedSignalBytes ?? TRANSPORT_SIGNAL_BYTES);
    const abortBytes = abortSignalWords * Uint32Array.BYTES_PER_ELEMENT;
    return createLockControlCarpet({
      signalBytes,
      abortBytes,
      lockSectorBytes: LOCK_SECTOR_BYTE_LENGTH,
      headerSlotStrideU32: HEADER_SLOT_STRIDE_U32,
      slotCount: 32 /* slots */,
      headerLayout: "split",
      createBuffer: createWasmSharedArrayBuffer
    });
  };
  const controlLayout = makeLockControlLayout();
  const lockPayload = makePayloadBuffer();
  const lockBuffers = {
    ...controlLayout.lock,
    payload: lockPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.lock.headers,
      payload: lockPayload
    })
  };
  const returnPayload = makePayloadBuffer();
  const returnLockBuffers = {
    ...controlLayout.returnLock,
    payload: returnPayload,
    textCompat: probeLockBufferTextCompat({
      headers: controlLayout.returnLock.headers,
      payload: returnPayload
    })
  };
  const lock = lock2({
    headers: lockBuffers.headers,
    headerSlotStrideU32: lockBuffers.headerSlotStrideU32,
    LockBoundSector: lockBuffers.lockSector,
    payload: lockBuffers.payload,
    payloadSector: lockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: lockBuffers.textCompat
  });
  const returnLock = lock2({
    headers: returnLockBuffers.headers,
    headerSlotStrideU32: returnLockBuffers.headerSlotStrideU32,
    LockBoundSector: returnLockBuffers.lockSector,
    payload: returnLockBuffers.payload,
    payloadSector: returnLockBuffers.payloadSector,
    payloadConfig: resolvedPayloadConfig,
    textCompat: returnLockBuffers.textCompat
  });
  const abortSignalSAB = usesAbortSignal === true ? controlLayout.abortSignals : undefined;
  const abortSignals = abortSignalSAB ? signalAbortFactory({
    sab: abortSignalSAB,
    maxSignals: resolvedAbortSignalCapacity
  }) : undefined;
  const signals = createSharedMemoryTransport({
    sabObject: externalSignalSab == null ? {
      size: requestedSignalBytes,
      sharedSab: controlLayout.signals
    } : sab,
    isMain: true,
    thread,
    debug
  });
  const signalBox = signals;
  const queue = createHostTxQueue({
    lock,
    returnLock,
    abortSignals
  });
  const {
    enqueue,
    rejectAll,
    txIdle
  } = queue;
  const channelHandler = new ChannelHandler;
  const { check } = hostDispatcherLoop({
    signalBox,
    queue,
    channelHandler,
    dispatcherOptions: host
  });
  channelHandler.open(check);
  let worker;
  const workerUrl = source ?? tsFileUrl;
  const workerDataPayload = {
    sab: signals.sab,
    abortSignalSAB,
    abortSignalMax: usesAbortSignal === true ? resolvedAbortSignalCapacity : undefined,
    list,
    ids,
    at,
    thread,
    debug,
    workerOptions,
    totalNumberOfThread,
    startAt: signalBox.startAt,
    lock: lockBuffers,
    returnLock: returnLockBuffers,
    payloadConfig: resolvedPayloadConfig,
    permission
  };
  const baseWorkerOptions = {
    type: "module",
    workerData: workerDataPayload
  };
  const nodeResourceLimits = toNodeWorkerResourceLimits(workerOptions?.resourceLimits);
  const baseNodeWorkerOptions = nodeResourceLimits ? { ...baseWorkerOptions, resourceLimits: nodeResourceLimits } : baseWorkerOptions;
  const withExecArgv = workerExecArgv && workerExecArgv.length > 0 ? { ...baseNodeWorkerOptions, execArgv: workerExecArgv } : baseNodeWorkerOptions;
  if (HAS_NODE_WORKER_THREADS) {
    try {
      worker = new poliWorker(workerUrl, withExecArgv);
    } catch (error) {
      if (error?.code === "ERR_WORKER_INVALID_EXEC_ARGV") {
        const fallbackExecArgv = toWorkerSafeExecArgv(withExecArgv.execArgv);
        if (fallbackExecArgv && fallbackExecArgv.length > 0) {
          try {
            worker = new poliWorker(workerUrl, { ...baseNodeWorkerOptions, execArgv: fallbackExecArgv });
          } catch (fallbackError) {
            if (fallbackError?.code === "ERR_WORKER_INVALID_EXEC_ARGV") {
              const compatExecArgv = toWorkerCompatExecArgv(fallbackExecArgv);
              if (compatExecArgv && compatExecArgv.length > 0) {
                try {
                  worker = new poliWorker(workerUrl, { ...baseNodeWorkerOptions, execArgv: compatExecArgv });
                } catch {
                  worker = new poliWorker(workerUrl, baseNodeWorkerOptions);
                }
              } else {
                worker = new poliWorker(workerUrl, baseNodeWorkerOptions);
              }
            } else {
              throw fallbackError;
            }
          }
        } else {
          worker = new poliWorker(workerUrl, baseNodeWorkerOptions);
        }
      } else {
        throw error;
      }
    }
  } else {
    worker = new poliWorker(workerUrl, {
      type: "module"
    });
    worker.postMessage?.(workerDataPayload);
  }
  let closedReason;
  const markWorkerClosed = (reason) => {
    if (closedReason)
      return;
    closedReason = reason;
    rejectAll(reason);
    channelHandler.close();
  };
  const onWorkerMessage = (message) => {
    if (!isWorkerFatalMessage(message))
      return;
    markWorkerClosed(`Worker startup failed: ${message[WORKER_FATAL_MESSAGE_KEY2]}`);
    terminateWorkerQuietly(worker);
  };
  const onWorkerError = (error) => {
    const message = String(error?.message ?? error);
    markWorkerClosed(`Worker crashed: ${message}`);
  };
  const nodeWorker = worker;
  if (typeof nodeWorker.on === "function") {
    nodeWorker.on("message", onWorkerMessage);
    nodeWorker.on("error", onWorkerError);
    nodeWorker.on("exit", (code) => {
      if (typeof code === "number" && code === 0)
        return;
      const normalized = typeof code === "number" ? code : -1;
      markWorkerClosed(`Worker exited with code ${normalized}`);
    });
  } else {
    const webWorker = worker;
    if (typeof webWorker.addEventListener === "function") {
      webWorker.addEventListener("message", (event) => {
        onWorkerMessage(event?.data);
      });
      webWorker.addEventListener("error", (event) => {
        onWorkerError(event?.error ?? event?.message ?? event);
      });
    } else {
      webWorker.onmessage = (event) => {
        onWorkerMessage(event?.data);
      };
      webWorker.onerror = (event) => {
        onWorkerError(event);
      };
    }
  }
  const thisSignal = signalBox.opView;
  const a_add = Atomics.add;
  const a_load2 = Atomics.load;
  const a_notify = Atomics.notify;
  const send = () => {
    if (check.isRunning === true)
      return;
    check.isRunning = true;
    Promise.resolve().then(check);
    if (a_load2(signalBox.rxStatus, 0) === 0) {
      a_add(thisSignal, 0, 1);
      a_notify(thisSignal, 0, 1);
    }
  };
  lock.setPromiseHandler((task, isRejected, value) => {
    queue.settlePromisePayload(task, isRejected, value);
    send();
  });
  const call = ({ fnNumber, timeout, abortSignal }) => {
    const enqueues = enqueue(fnNumber, timeout, abortSignal);
    return (args) => {
      const pending = enqueues(args);
      send();
      return pending;
    };
  };
  const context = {
    txIdle,
    call,
    kills: async () => {
      markWorkerClosed("Thread closed");
      try {
        Promise.resolve(worker.terminate()).catch(() => {});
      } catch {}
    },
    lock
  };
  return context;
};

// src/common/path-canonical.ts
var toCanonicalPath = (candidate, fsApi = {
  existsSync: existsSyncCompat,
  realpathSync: realpathSyncCompat
}) => {
  const absolute = pathResolve(candidate);
  const { existsSync, realpathSync } = fsApi;
  if (typeof realpathSync === "function") {
    try {
      return pathResolve(realpathSync(absolute));
    } catch {}
  } else {
    return absolute;
  }
  if (typeof existsSync !== "function")
    return absolute;
  const missingSegments = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = pathDirname(cursor);
    if (parent === cursor)
      return absolute;
    missingSegments.push(pathBasename(cursor));
    cursor = parent;
  }
  let base = cursor;
  try {
    base = realpathSync(cursor);
  } catch {}
  let rebuilt = base;
  for (let i = missingSegments.length - 1;i >= 0; i--) {
    rebuilt = pathJoin(rebuilt, missingSegments[i]);
  }
  return pathResolve(rebuilt);
};

// src/permission/protocol.ts
var DEFAULT_ENV_FILE = ".env";
var DEFAULT_DENO_LOCK_FILE = "deno.lock";
var NODE_MODULES_DIR = "node_modules";
var DEFAULT_DENY_RELATIVE = [
  ".env",
  ".git",
  ".npmrc",
  ".docker",
  ".secrets"
];
var DEFAULT_ALLOW_IMPORT_HOSTS = ["deno.land", "esm.sh", "jsr.io"];
var SUPPORTED_SYS_API_NAMES = [
  "hostname",
  "osRelease",
  "osUptime",
  "loadavg",
  "networkInterfaces",
  "systemMemoryInfo",
  "uid",
  "gid"
];
var SUPPORTED_SYS_API_NAME_SET = new Set(SUPPORTED_SYS_API_NAMES);
var L3_KEYS = {
  deno: [],
  node: [
    "denyRead",
    "denyWrite",
    "net",
    "denyNet",
    "env.allow",
    "env.deny",
    "denyRun",
    "denyFfi",
    "sys",
    "denySys",
    "allowImport"
  ]
};
var cloneL3Keys = () => ({
  deno: [...L3_KEYS.deno],
  node: [...L3_KEYS.node]
});
var DEFAULT_DENY_HOME = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube"
];
var DEFAULT_DENY_ABSOLUTE_POSIX = [
  "/proc",
  "/proc/self",
  "/proc/self/environ",
  "/proc/self/mem",
  "/sys",
  "/dev",
  "/etc"
];
var normalizeList = (values) => {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    if (seen.has(value))
      continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};
var normalizeStringList = (values) => {
  if (!values || values.length === 0)
    return [];
  const cleaned = [];
  for (const value of values) {
    if (typeof value !== "string")
      continue;
    const trimmed = value.trim();
    if (trimmed.length === 0)
      continue;
    cleaned.push(trimmed);
  }
  return normalizeList(cleaned);
};
var normalizeSysApiList = (values) => {
  if (!values || values.length === 0)
    return [];
  const out = [];
  const seen = new Set;
  for (const raw of values) {
    if (typeof raw !== "string")
      continue;
    const value = raw.trim();
    if (value.length === 0 || seen.has(value))
      continue;
    if (!SUPPORTED_SYS_API_NAME_SET.has(value))
      continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};
var hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
var normalizeProtocolInput = (input) => !input ? undefined : typeof input === "string" ? { mode: input } : input;
var isWindows = () => {
  if (typeof process !== "undefined")
    return process.platform === "win32";
  const g = globalThis;
  return g.Deno?.build?.os === "windows";
};
var getCwd = () => {
  try {
    if (typeof process !== "undefined" && typeof process.cwd === "function") {
      return process.cwd();
    }
  } catch {}
  const g = globalThis;
  try {
    if (typeof g.Deno?.cwd === "function")
      return g.Deno.cwd();
  } catch {}
  return ".";
};
var getHome = () => {
  try {
    if (typeof process !== "undefined" && typeof process.env === "object") {
      const home = process.env.HOME ?? process.env.USERPROFILE;
      if (typeof home === "string" && home.length > 0)
        return home;
    }
  } catch {}
  const g = globalThis;
  try {
    const home = g.Deno?.env?.get?.("HOME") ?? g.Deno?.env?.get?.("USERPROFILE");
    if (typeof home === "string" && home.length > 0)
      return home;
  } catch {}
  return;
};
var expandHomePath = (value, home) => {
  if (!home)
    return value;
  if (value === "~")
    return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return pathResolve(home, value.slice(2));
  }
  return value;
};
var toAbsolutePath = (value, cwd, home) => {
  if (value instanceof URL) {
    if (value.protocol !== "file:")
      return;
    return pathResolve(fileURLToPathCompat(value));
  }
  const expanded = expandHomePath(value, home);
  if (pathIsAbsolute(expanded)) {
    return pathResolve(expanded);
  }
  try {
    const parsed = new URL(expanded);
    if (parsed.protocol !== "file:")
      return;
    return pathResolve(fileURLToPathCompat(parsed));
  } catch {
    return pathResolve(cwd, expanded);
  }
};
var toPath = (value, cwd, home) => value == null ? undefined : toAbsolutePath(value, cwd, home);
var toPathList = (values, cwd, home) => {
  if (!values?.length)
    return [];
  const out = [];
  for (const value of values) {
    const resolved = toPath(value, cwd, home);
    if (resolved)
      out.push(resolved);
  }
  return out;
};
var toUniquePathList = (values, cwd, home) => normalizeList(toPathList(values, cwd, home));
var toEnvFiles = (input, cwd, home) => {
  const values = Array.isArray(input) ? input : input ? [input] : [DEFAULT_ENV_FILE];
  return toUniquePathList(values, cwd, home);
};
var rawRealpathSync = realpathSyncCompat;
var toCanonicalPath2 = (candidate) => {
  return toCanonicalPath(candidate, {
    existsSync: existsSyncCompat,
    realpathSync: rawRealpathSync
  });
};
var isPathWithin = (base, candidate) => {
  const canonicalBase = toCanonicalPath2(base);
  const canonicalCandidate = toCanonicalPath2(candidate);
  const relative = pathRelative(canonicalBase, canonicalCandidate);
  return relative === "" || !relative.startsWith("..") && !pathIsAbsolute(relative);
};
var defaultSensitiveProjectAndHomePaths = (cwd, home) => {
  const projectSensitive = DEFAULT_DENY_RELATIVE.map((entry) => pathResolve(cwd, entry));
  const homeSensitive = home ? DEFAULT_DENY_HOME.map((entry) => pathResolve(home, entry)) : [];
  return normalizeList([...projectSensitive, ...homeSensitive]);
};
var defaultSensitiveReadDenyPaths = (cwd, home) => {
  const projectAndHome = defaultSensitiveProjectAndHomePaths(cwd, home);
  const osSensitive = isWindows() ? [] : DEFAULT_DENY_ABSOLUTE_POSIX.map((entry) => pathResolve(entry));
  return normalizeList([...projectAndHome, ...osSensitive]);
};
var collectWritePaths = (cwd, values) => {
  const out = normalizeList(values.length > 0 ? values : [cwd]);
  if (!out.some((entry) => isPathWithin(entry, cwd) || isPathWithin(cwd, entry))) {
    out.unshift(cwd);
  }
  return normalizeList(out);
};
var collectReadPaths = ({
  cwd,
  read,
  moduleFiles,
  envFiles,
  denoLock
}) => {
  const out = [
    cwd,
    pathResolve(cwd, NODE_MODULES_DIR),
    ...read,
    ...moduleFiles,
    ...envFiles
  ];
  if (denoLock)
    out.push(denoLock);
  return normalizeList(out);
};
var resolveDenoLock = (input, cwd, home) => {
  if (input === false)
    return;
  if (input && input !== true) {
    return toPath(input, cwd, home);
  }
  return pathResolve(cwd, DEFAULT_DENO_LOCK_FILE);
};
var resolveNodePermissionActivationFlag = () => {
  try {
    if (typeof process !== "undefined") {
      const raw = process.versions?.node;
      const major = Number.parseInt(String(raw).split(".", 1)[0] ?? "", 10);
      if (Number.isFinite(major) && major > 0 && major < 22) {
        return "--experimental-permission";
      }
    }
  } catch {}
  return "--permission";
};
var toNodeFlags = ({
  read,
  readAll,
  write,
  writeAll,
  envFiles,
  node
}) => {
  const modelFlags = [];
  if (readAll) {
    modelFlags.push("--allow-fs-read=*");
  } else if (read.length > 0) {
    modelFlags.push(`--allow-fs-read=${read.join(",")}`);
  }
  if (writeAll) {
    modelFlags.push("--allow-fs-write=*");
  } else if (write.length > 0) {
    modelFlags.push(`--allow-fs-write=${write.join(",")}`);
  }
  if (node.allowWorker)
    modelFlags.push("--allow-worker");
  if (node.allowChildProcess)
    modelFlags.push("--allow-child-process");
  if (node.allowAddons)
    modelFlags.push("--allow-addons");
  if (node.allowWasi)
    modelFlags.push("--allow-wasi");
  const flags = [];
  if (modelFlags.length > 0) {
    flags.push(resolveNodePermissionActivationFlag(), ...modelFlags);
  }
  for (const file of envFiles) {
    flags.push(`--env-file-if-exists=${file}`);
  }
  return flags;
};
var toDenoFlags = ({
  read,
  readAll,
  write,
  writeAll,
  denyRead,
  denyWrite,
  net,
  netAll,
  denyNet,
  allowImport,
  allowImportAll,
  envAllow,
  envAllowAll,
  envDeny,
  envFiles,
  run,
  runAll,
  denyRun,
  ffi,
  ffiAll,
  denyFfi,
  sys,
  sysAll,
  denySys,
  denoLock,
  denoLockEnabled,
  frozen
}) => {
  const flags = [];
  if (readAll) {
    flags.push("--allow-read");
  } else if (read.length > 0) {
    flags.push(`--allow-read=${read.join(",")}`);
  }
  if (writeAll) {
    flags.push("--allow-write");
  } else if (write.length > 0) {
    flags.push(`--allow-write=${write.join(",")}`);
  }
  if (denyRead.length > 0) {
    flags.push(`--deny-read=${denyRead.join(",")}`);
  }
  if (denyWrite.length > 0) {
    flags.push(`--deny-write=${denyWrite.join(",")}`);
  }
  if (netAll) {
    flags.push("--allow-net");
  } else if (net.length > 0) {
    flags.push(`--allow-net=${net.join(",")}`);
  }
  if (denyNet.length > 0) {
    flags.push(`--deny-net=${denyNet.join(",")}`);
  }
  if (allowImportAll) {
    flags.push("--allow-import");
  } else if (allowImport.length > 0) {
    flags.push(`--allow-import=${allowImport.join(",")}`);
  }
  if (envAllowAll) {
    flags.push("--allow-env");
  } else if (envAllow.length > 0) {
    flags.push(`--allow-env=${envAllow.join(",")}`);
  }
  if (envDeny.length > 0) {
    flags.push(`--deny-env=${envDeny.join(",")}`);
  }
  for (const file of envFiles) {
    flags.push(`--env-file=${file}`);
  }
  if (runAll) {
    flags.push("--allow-run");
  } else if (run.length > 0) {
    flags.push(`--allow-run=${run.join(",")}`);
  }
  if (denyRun.length > 0) {
    flags.push(`--deny-run=${denyRun.join(",")}`);
  }
  if (ffiAll) {
    flags.push("--allow-ffi");
  } else if (ffi.length > 0) {
    flags.push(`--allow-ffi=${ffi.join(",")}`);
  }
  if (denyFfi.length > 0) {
    flags.push(`--deny-ffi=${denyFfi.join(",")}`);
  }
  if (sysAll) {
    flags.push("--allow-sys");
  } else if (sys.length > 0) {
    flags.push(`--allow-sys=${sys.join(",")}`);
  }
  if (denySys.length > 0) {
    flags.push(`--deny-sys=${denySys.join(",")}`);
  }
  if (!denoLockEnabled) {
    flags.push("--no-lock");
  } else if (denoLock) {
    flags.push(`--lock=${denoLock}`);
    if (frozen)
      flags.push("--frozen=true");
  }
  return flags;
};
var resolvePermissionProtocol = ({
  permission,
  modules
}) => {
  const input = normalizeProtocolInput(permission);
  if (!input)
    return;
  const rawMode = input.mode;
  const mode = rawMode === "unsafe" || rawMode === "off" ? "unsafe" : rawMode === "custom" ? "custom" : "strict";
  const unsafe = mode === "unsafe";
  const allowConsole = input.console ?? unsafe;
  const cwd = pathResolve(input.cwd ?? getCwd());
  const home = getHome();
  const envFiles = toEnvFiles(input.env?.files, cwd, home);
  const moduleFiles = toUniquePathList(modules, cwd, home);
  const denoLockInput = input.deno?.lock;
  const denoLockEnabled = denoLockInput !== false;
  const denoLock = resolveDenoLock(denoLockInput, cwd, home);
  if (unsafe) {
    return {
      enabled: true,
      mode,
      unsafe: true,
      allowConsole,
      cwd,
      read: [],
      readAll: true,
      write: [],
      writeAll: true,
      denyRead: [],
      denyWrite: [],
      net: [],
      netAll: true,
      denyNet: [],
      allowImport: [],
      allowImportAll: true,
      env: {
        allow: [],
        allowAll: true,
        deny: [],
        files: envFiles
      },
      envFiles,
      run: [],
      runAll: true,
      denyRun: [],
      workers: true,
      ffi: [],
      ffiAll: true,
      denyFfi: [],
      sys: [],
      sysAll: true,
      denySys: [],
      wasi: true,
      lockFiles: {
        deno: denoLock
      },
      node: {
        allowWorker: true,
        allowChildProcess: true,
        allowAddons: true,
        allowWasi: true,
        flags: []
      },
      deno: {
        frozen: false,
        allowRun: true,
        flags: []
      },
      l3: cloneL3Keys()
    };
  }
  const nodeModulesPath = pathResolve(cwd, NODE_MODULES_DIR);
  const hasExplicitDenyRead = hasOwn(input, "denyRead");
  const hasExplicitDenyWrite = hasOwn(input, "denyWrite");
  const hasExplicitRead = hasOwn(input, "read");
  const hasExplicitWrite = hasOwn(input, "write");
  const denyReadDefaults = defaultSensitiveReadDenyPaths(cwd, home);
  const denyWriteDefaults = normalizeList([
    ...defaultSensitiveProjectAndHomePaths(cwd, home),
    nodeModulesPath
  ]);
  const denyRead = normalizeList([
    ...toPathList(input.denyRead, cwd, home),
    ...mode === "custom" && hasExplicitDenyRead ? [] : denyReadDefaults
  ]);
  const denyWrite = normalizeList([
    ...toPathList(input.denyWrite, cwd, home),
    ...mode === "custom" && hasExplicitDenyWrite ? [] : denyWriteDefaults
  ]);
  const readAll = input.read === true;
  const writeAll = input.write === true;
  const configuredRead = readAll ? [] : toPathList(Array.isArray(input.read) ? input.read : undefined, cwd, home);
  const configuredWrite = writeAll ? [] : toPathList(Array.isArray(input.write) ? input.write : undefined, cwd, home);
  const resolvedRead = readAll ? [] : hasExplicitRead ? normalizeList(configuredRead) : collectReadPaths({
    cwd,
    read: configuredRead,
    moduleFiles,
    envFiles,
    denoLock
  });
  const resolvedWrite = writeAll ? [] : hasExplicitWrite ? normalizeList(configuredWrite) : collectWritePaths(cwd, configuredWrite);
  const netAll = input.net === true;
  const net = netAll ? [] : normalizeStringList(Array.isArray(input.net) ? input.net : []);
  const denyNet = normalizeStringList(input.denyNet);
  const allowImportAll = input.allowImport === true;
  const allowImport = allowImportAll ? [] : normalizeStringList(Array.isArray(input.allowImport) ? input.allowImport : [...DEFAULT_ALLOW_IMPORT_HOSTS]);
  const envAllowAll = input.env?.allow === true;
  const envAllow = envAllowAll ? [] : normalizeStringList(Array.isArray(input.env?.allow) ? input.env.allow : []);
  const envDeny = normalizeStringList(input.env?.deny);
  const legacyRunEnabled = input.node?.allowChildProcess === true || input.deno?.allowRun === true;
  const runSource = hasOwn(input, "run") ? input.run : legacyRunEnabled ? true : [];
  const runAll = runSource === true;
  const run = runAll ? [] : normalizeStringList(Array.isArray(runSource) ? runSource : []);
  const denyRun = normalizeStringList(input.denyRun);
  const workers = hasOwn(input, "workers") ? input.workers === true : input.node?.allowWorker === true;
  const ffiSource = hasOwn(input, "ffi") ? input.ffi : input.node?.allowAddons === true ? true : false;
  const ffiAll = ffiSource === true;
  const ffi = ffiAll ? [] : toUniquePathList(Array.isArray(ffiSource) ? ffiSource : undefined, cwd, home);
  const denyFfi = toUniquePathList(input.denyFfi, cwd, home);
  const sysSource = input.sys;
  const sysAll = sysSource === true;
  const sys = sysAll ? [] : normalizeSysApiList(Array.isArray(sysSource) ? sysSource : []);
  const denySys = normalizeSysApiList(input.denySys);
  const wasi = hasOwn(input, "wasi") ? input.wasi === true : input.node?.allowWasi === true;
  const nodeSettings = {
    allowWorker: workers,
    allowChildProcess: runAll || run.length > 0,
    allowAddons: ffiAll || ffi.length > 0,
    allowWasi: wasi
  };
  const denoSettings = {
    frozen: input.deno?.frozen !== false,
    allowRun: runAll || run.length > 0
  };
  return {
    enabled: true,
    mode,
    unsafe: false,
    allowConsole,
    cwd,
    read: resolvedRead,
    readAll,
    write: resolvedWrite,
    writeAll,
    denyRead,
    denyWrite,
    net,
    netAll,
    denyNet,
    allowImport,
    allowImportAll,
    env: {
      allow: envAllow,
      allowAll: envAllowAll,
      deny: envDeny,
      files: envFiles
    },
    envFiles,
    run,
    runAll,
    denyRun,
    workers,
    ffi,
    ffiAll,
    denyFfi,
    sys,
    sysAll,
    denySys,
    wasi,
    lockFiles: {
      deno: denoLock
    },
    node: {
      ...nodeSettings,
      flags: toNodeFlags({
        read: resolvedRead,
        readAll,
        write: resolvedWrite,
        writeAll,
        envFiles,
        node: nodeSettings
      })
    },
    deno: {
      ...denoSettings,
      flags: toDenoFlags({
        read: resolvedRead,
        readAll,
        write: resolvedWrite,
        writeAll,
        denyRead,
        denyWrite,
        net,
        netAll,
        denyNet,
        allowImport,
        allowImportAll,
        envAllow,
        envAllowAll,
        envDeny,
        envFiles,
        run,
        runAll,
        denyRun,
        ffi,
        ffiAll,
        denyFfi,
        sys,
        sysAll,
        denySys,
        denoLock,
        denoLockEnabled,
        frozen: denoSettings.frozen
      })
    },
    l3: cloneL3Keys()
  };
};
var toRuntimePermissionFlags = (protocol) => protocol?.enabled === true && protocol.unsafe !== true ? RUNTIME === "node" ? protocol.node.flags : RUNTIME === "deno" ? protocol.deno.flags : [] : [];
// src/runtime/balancer.ts
var selectStrategy = (contexts, handlers, strategy) => {
  switch (strategy ?? "roundRobin") {
    case "roundRobin":
    case "robinRound":
      return roundRobin(contexts)(handlers)(handlers.length);
    case "firstIdle":
      return firstIdle(contexts)(handlers)(handlers.length);
    case "randomLane":
      return randomLane(contexts)(handlers)(handlers.length);
    case "firstIdleOrRandom":
      return firstIdleRandom(contexts)(handlers)(handlers.length);
  }
  throw new Error(`Unknown balancer: ${strategy}`);
};
var managerMethod = ({
  contexts,
  balancer,
  handlers,
  inlinerGate
}) => {
  const strategy = typeof balancer === "object" && balancer != null ? balancer.strategy : balancer;
  if (contexts.length < 2) {
    throw new Error(contexts.length === 0 ? "No threads available." : "Cannot rotate with a single thread.");
  }
  if (handlers.length === 0) {
    throw new Error("No handlers provided.");
  }
  const allInvoker = selectStrategy(contexts, handlers, strategy);
  if (!inlinerGate) {
    return allInvoker;
  }
  const inlinerIndex = inlinerGate.index | 0;
  const threshold = Number.isFinite(inlinerGate.threshold) ? Math.max(1, Math.floor(inlinerGate.threshold)) : 1;
  if (threshold <= 1 || inlinerIndex < 0 || inlinerIndex >= handlers.length) {
    return allInvoker;
  }
  const workerLaneCount = handlers.length - 1;
  if (workerLaneCount <= 0) {
    return allInvoker;
  }
  const workerHandlers = new Array(workerLaneCount);
  const workerContexts = new Array(workerLaneCount);
  for (let source = 0, lane = 0;source < handlers.length; source += 1) {
    if (source === inlinerIndex)
      continue;
    workerHandlers[lane] = handlers[source];
    workerContexts[lane] = contexts[source];
    lane += 1;
  }
  const workerOnlyInvoker = selectStrategy(workerContexts, workerHandlers, strategy);
  let inFlight = 0;
  const releaseResolved = (value) => {
    inFlight -= 1;
    return value;
  };
  const releaseRejected = (error) => {
    inFlight -= 1;
    throw error;
  };
  return (args) => {
    inFlight += 1;
    const invoker = inFlight >= threshold ? allInvoker : workerOnlyInvoker;
    try {
      return invoker(args).then(releaseResolved, releaseRejected);
    } catch (error) {
      inFlight -= 1;
      throw error;
    }
  };
};
function roundRobin(_contexts) {
  return (handlers) => {
    return (max) => {
      const top = Math.min(max, handlers.length);
      if (top <= 1) {
        return (args) => handlers[0](args);
      }
      let rrCursor = 0;
      return (args) => {
        const lane = rrCursor;
        rrCursor += 1;
        if (rrCursor === top)
          rrCursor = 0;
        return handlers[lane](args);
      };
    };
  };
}
function firstIdle(contexts) {
  const isSolved = contexts.map((ctx) => ctx.txIdle);
  return (handlers) => {
    return (max) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args) => handlers[0](args);
      }
      let rrCursor = 0;
      return (args) => {
        for (let lane = 0;lane < laneCount; lane += 1) {
          if (isSolved[lane]()) {
            return handlers[lane](args);
          }
        }
        const fallback = rrCursor;
        rrCursor += 1;
        if (rrCursor === laneCount)
          rrCursor = 0;
        return handlers[fallback](args);
      };
    };
  };
}
var randomLane = (_) => {
  return (handlers) => {
    return (max) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args) => handlers[0](args);
      }
      return (args) => {
        const lane = Math.random() * laneCount | 0;
        return handlers[lane](args);
      };
    };
  };
};
function firstIdleRandom(contexts) {
  const isSolved = contexts.map((ctx) => ctx.txIdle);
  return (handlers) => {
    return (max) => {
      const laneCount = Math.min(max, handlers.length);
      if (laneCount <= 1) {
        return (args) => handlers[0](args);
      }
      return (args) => {
        for (let lane = 0;lane < laneCount; lane += 1) {
          if (isSolved[lane]()) {
            return handlers[lane](args);
          }
        }
        const fallback = Math.random() * laneCount | 0;
        return handlers[fallback](args);
      };
    };
  };
}

// src/runtime/inline-executor.ts
var normalizeTimeout2 = (timeout) => {
  if (timeout == null)
    return;
  if (typeof timeout === "number") {
    return timeout >= 0 ? { ms: timeout, kind: 0 /* Reject */, value: new Error("Task timeout") } : undefined;
  }
  const ms = timeout.time;
  if (!(ms >= 0))
    return;
  if ("default" in timeout) {
    return { ms, kind: 1 /* Resolve */, value: timeout.default };
  }
  if (timeout.maybe === true) {
    return { ms, kind: 1 /* Resolve */, value: undefined };
  }
  if ("error" in timeout) {
    return { ms, kind: 0 /* Reject */, value: timeout.error };
  }
  return { ms, kind: 0 /* Reject */, value: new Error("Task timeout") };
};
var raceTimeout2 = (promise, spec) => new Promise((resolve, reject) => {
  let done = false;
  const timer = setTimeout(() => {
    if (done)
      return;
    done = true;
    if (spec.kind === 1 /* Resolve */) {
      resolve(spec.value);
    } else {
      reject(spec.value);
    }
  }, spec.ms);
  promise.then((value) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    resolve(value);
  }, (err) => {
    if (done)
      return;
    done = true;
    clearTimeout(timer);
    reject(err);
  });
});
var INLINE_ABORT_TOOLKIT = (() => {
  const hasAborted = () => false;
  return {
    hasAborted
  };
})();
var composeInlineCallable = (fn, timeout, useAbortToolkit = false) => {
  const normalized = normalizeTimeout2(timeout);
  const run = useAbortToolkit ? (args) => fn(args, INLINE_ABORT_TOOLKIT) : fn;
  if (!normalized)
    return run;
  return (args) => {
    const result = run(args);
    return result instanceof Promise ? raceTimeout2(result, normalized) : result;
  };
};
var createInlineExecutor = ({
  tasks,
  genTaskID: genTaskID2,
  batchSize
}) => {
  const entries = Object.values(tasks).sort((a, b) => a.id - b.id);
  const runners = entries.map((entry) => composeInlineCallable(entry.f, entry.timeout, entry.abortSignal !== undefined));
  const initCap = 16;
  let fnByIndex = new Int32Array(initCap);
  let stateByIndex = new Int8Array(initCap).fill(-1 /* Free */);
  let argsByIndex = new Array(initCap);
  let taskIdByIndex = new Array(initCap).fill(-1);
  let deferredByIndex = new Array(initCap);
  const freeStack = new Array(initCap);
  let freeTop = initCap;
  for (let i = 0;i < initCap; i++)
    freeStack[i] = initCap - 1 - i;
  const pendingQueue = new RingQueue(initCap);
  let working = 0;
  let isInMacro = false;
  let isInMicro = false;
  const batchLimit = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize ?? 1)) : Number.POSITIVE_INFINITY;
  const channel = createRuntimeMessageChannel();
  const port1 = channel.port1;
  const port2 = channel.port2;
  const post2 = port2.postMessage.bind(port2);
  const hasPending = () => pendingQueue.isEmpty === false;
  const queueMicro = typeof queueMicrotask === "function" ? queueMicrotask : (callback) => Promise.resolve().then(callback);
  const scheduleMacro = () => {
    if (working === 0 || isInMacro)
      return;
    isInMacro = true;
    post2(null);
  };
  const send = () => {
    if (working === 0 || isInMacro || isInMicro)
      return;
    isInMicro = true;
    queueMicro(runMicroLoop);
  };
  const enqueue = (index) => {
    pendingQueue.push(index);
    send();
  };
  const enqueueIfCurrent = (index, taskID) => {
    if (stateByIndex[index] !== 0 /* Pending */ || taskIdByIndex[index] !== taskID)
      return;
    enqueue(index);
  };
  const settleIfCurrent = (index, taskID, isError, value) => {
    if (stateByIndex[index] !== 0 /* Pending */ || taskIdByIndex[index] !== taskID)
      return;
    const deferred = deferredByIndex[index];
    if (deferred) {
      if (isError)
        deferred.reject(value);
      else
        deferred.resolve(value);
    }
    cleanup(index);
  };
  function allocIndex() {
    if (freeTop > 0)
      return freeStack[--freeTop];
    const oldCap = fnByIndex.length;
    const newCap = oldCap << 1;
    const nextFnByIndex = new Int32Array(newCap);
    nextFnByIndex.set(fnByIndex);
    fnByIndex = nextFnByIndex;
    const nextStateByIndex = new Int8Array(newCap);
    nextStateByIndex.fill(-1 /* Free */);
    nextStateByIndex.set(stateByIndex);
    stateByIndex = nextStateByIndex;
    argsByIndex.length = newCap;
    taskIdByIndex.length = newCap;
    taskIdByIndex.fill(-1, oldCap);
    deferredByIndex.length = newCap;
    for (let i = newCap - 1;i >= oldCap; --i) {
      freeStack[freeTop++] = i;
    }
    return freeStack[--freeTop];
  }
  function processLoop(fromMicro = false) {
    let processed = 0;
    while (processed < batchLimit) {
      const maybeIndex = pendingQueue.shiftNoClear();
      if (maybeIndex === undefined)
        break;
      const index = maybeIndex | 0;
      if (stateByIndex[index] !== 0 /* Pending */)
        continue;
      const taskID = taskIdByIndex[index];
      try {
        const args = argsByIndex[index];
        const fnId = fnByIndex[index];
        const res = runners[fnId](args);
        if (!(res instanceof Promise)) {
          settleIfCurrent(index, taskID, false, res);
          processed++;
          continue;
        }
        res.then((value) => settleIfCurrent(index, taskID, false, value), (err) => settleIfCurrent(index, taskID, true, err));
        processed++;
      } catch (err) {
        settleIfCurrent(index, taskID, true, err);
        processed++;
      }
    }
    if (hasPending()) {
      if (fromMicro) {
        scheduleMacro();
      } else {
        post2(null);
      }
      return;
    }
    if (!fromMicro) {
      isInMacro = false;
    }
  }
  function runMicroLoop() {
    if (!isInMicro)
      return;
    processLoop(true);
    isInMicro = false;
  }
  function cleanup(index) {
    working--;
    stateByIndex[index] = -1 /* Free */;
    fnByIndex[index] = 0;
    taskIdByIndex[index] = -1;
    argsByIndex[index] = undefined;
    deferredByIndex[index] = undefined;
    freeStack[freeTop++] = index;
    if (working === 0)
      isInMacro = false;
  }
  const call = ({ fnNumber }) => (args) => {
    const taskID = genTaskID2();
    const deferred = withResolvers();
    const index = allocIndex();
    taskIdByIndex[index] = taskID;
    argsByIndex[index] = args;
    fnByIndex[index] = fnNumber | 0;
    deferredByIndex[index] = deferred;
    stateByIndex[index] = 0 /* Pending */;
    working++;
    if (args instanceof Promise) {
      args.then((value) => {
        if (taskIdByIndex[index] !== taskID)
          return;
        argsByIndex[index] = value;
        enqueueIfCurrent(index, taskID);
      }, (err) => settleIfCurrent(index, taskID, true, err));
    } else {
      enqueue(index);
    }
    return deferred.promise;
  };
  port1.onmessage = () => processLoop(false);
  return {
    kills: async () => {
      for (let index = 0;index < stateByIndex.length; index++) {
        if (stateByIndex[index] !== 0 /* Pending */)
          continue;
        try {
          deferredByIndex[index]?.reject("Thread closed");
        } catch {}
      }
      port1.onmessage = null;
      port1.close();
      port2.onmessage = null;
      port2.close();
      pendingQueue.clear();
      freeTop = 0;
      freeStack.length = 0;
      argsByIndex.fill(undefined);
      taskIdByIndex.fill(-1);
      deferredByIndex.fill(undefined);
      fnByIndex.fill(0);
      stateByIndex.fill(-1 /* Free */);
      working = 0;
      isInMacro = false;
      isInMicro = false;
    },
    call,
    txIdle: () => working === 0
  };
};

// src/api.ts
var MAX_FUNCTION_ID = 65535;
var MAX_FUNCTION_COUNT = MAX_FUNCTION_ID + 1;
var isMain = RUNTIME_IS_MAIN_THREAD;
var toListAndIds = (args) => {
  const result = Object.values(args).reduce((acc, v) => (acc[0].add(v.importedFrom), acc[1].add(v.id), acc[2].add(v.at), acc), [
    new Set,
    new Set,
    new Set
  ]);
  return {
    list: [...result[0]],
    ids: [...result[1]],
    at: [...result[2]]
  };
};
var createPool = ({
  threads,
  debug,
  inliner,
  balancer,
  payload,
  payloadInitialBytes,
  payloadMaxBytes,
  bufferMode,
  maxPayloadBytes,
  abortSignalCapacity,
  source,
  worker,
  workerExecArgv,
  permission,
  dispatcher,
  host
}) => (tasks) => {
  if (RUNTIME_IS_MAIN_THREAD === false) {
    if (debug?.extras === true) {
      console.warn("createPool has been called with : " + JSON.stringify(RUNTIME_WORKER_DATA));
    }
    const notMainThreadError = () => {
      throw new Error("createPool can only be called in the main thread.");
    };
    const throwingProxyTarget = function() {
      return notMainThreadError();
    };
    const throwingProxyHandler = {
      get: function() {
        return notMainThreadError;
      }
    };
    const mainThreadOnlyProxy = new Proxy(throwingProxyTarget, throwingProxyHandler);
    return {
      shutdown: mainThreadOnlyProxy,
      call: mainThreadOnlyProxy
    };
  }
  const { list, ids, at } = toListAndIds(tasks), listOfFunctions = Object.entries(tasks).map(([k, v]) => ({
    ...v,
    name: k
  })).sort((a, b) => a.name.localeCompare(b.name));
  if (listOfFunctions.length > MAX_FUNCTION_COUNT) {
    throw new RangeError(`Too many tasks: received ${listOfFunctions.length}. ` + `Maximum is ${MAX_FUNCTION_COUNT} (Uint16 function IDs: 0..${MAX_FUNCTION_ID}).`);
  }
  const usingInliner = typeof inliner === "object" && inliner != null;
  const totalNumberOfThread = (threads ?? 1) + (usingInliner ? 1 : 0);
  const permissionProtocol = resolvePermissionProtocol({
    permission: permission ?? {
      mode: "strict",
      allowImport: true
    },
    modules: list
  });
  const permissionExecArgv = toRuntimePermissionFlags(permissionProtocol);
  const allowedFlags = typeof process !== "undefined" && process.allowedNodeEnvironmentFlags ? process.allowedNodeEnvironmentFlags : null;
  const isNodePermissionFlag = (flag) => {
    const key = flag.split("=", 1)[0];
    return key === "--permission" || key === "--experimental-permission" || key === "--allow-fs-read" || key === "--allow-fs-write" || key === "--allow-worker" || key === "--allow-child-process" || key === "--allow-addons" || key === "--allow-wasi";
  };
  const stripNodePermissionFlags = (flags) => flags?.filter((flag) => !isNodePermissionFlag(flag));
  const dedupeFlags = (flags) => {
    const out = [];
    const seen = new Set;
    for (const flag of flags) {
      if (seen.has(flag))
        continue;
      seen.add(flag);
      out.push(flag);
    }
    return out;
  };
  const sanitizeExecArgv = (flags) => {
    if (!flags || flags.length === 0)
      return;
    if (!allowedFlags)
      return flags;
    const filtered = flags.filter((flag) => {
      const key = flag.split("=", 1)[0];
      return allowedFlags.has(key);
    });
    return filtered.length > 0 ? filtered : undefined;
  };
  const defaultExecArgvCandidate = workerExecArgv ?? (typeof process !== "undefined" && Array.isArray(process.execArgv) ? allowedFlags?.has("--expose-gc") === true ? process.execArgv.includes("--expose-gc") ? process.execArgv : [...process.execArgv, "--expose-gc"] : process.execArgv : undefined);
  const defaultExecArgv = permissionProtocol?.unsafe === true ? stripNodePermissionFlags(defaultExecArgvCandidate) : defaultExecArgvCandidate;
  const combinedExecArgv = dedupeFlags([
    ...permissionExecArgv,
    ...defaultExecArgv ?? []
  ]);
  const execArgv = sanitizeExecArgv(combinedExecArgv.length > 0 ? combinedExecArgv : undefined);
  const hostDispatcher = host ?? dispatcher;
  const usesAbortSignal = listOfFunctions.some((fn) => fn.abortSignal !== undefined);
  const hardTimeoutMs = Number.isFinite(worker?.hardTimeoutMs) ? Math.max(1, Math.floor(worker?.hardTimeoutMs)) : undefined;
  let workers = Array.from({
    length: threads ?? 1
  }).map((_, thread) => spawnWorkerContext({
    list,
    ids,
    at,
    thread,
    debug,
    totalNumberOfThread,
    source,
    workerOptions: worker,
    workerExecArgv: execArgv,
    host: hostDispatcher,
    payload,
    payloadInitialBytes,
    payloadMaxBytes,
    bufferMode,
    maxPayloadBytes,
    abortSignalCapacity,
    usesAbortSignal,
    permission: permissionProtocol
  }));
  if (usingInliner) {
    const mainThread = createInlineExecutor({
      tasks,
      genTaskID,
      batchSize: inliner?.batchSize ?? 1
    });
    if (inliner?.position === "first") {
      workers = [
        mainThread,
        ...workers
      ];
    } else {
      workers.push(mainThread);
    }
  }
  const inlinerIndex = usingInliner ? inliner?.position === "first" ? 0 : workers.length - 1 : -1;
  const inlinerDispatchThreshold = Number.isFinite(inliner?.dispatchThreshold) ? Math.max(1, Math.floor(inliner?.dispatchThreshold ?? 1)) : 1;
  let closing = false;
  let closePromise;
  let shutdownPromise;
  const closePoolNow = () => {
    if (closePromise)
      return closePromise;
    closing = true;
    closePromise = Promise.allSettled(workers.map((context) => context.kills())).then(() => {
      return;
    });
    return closePromise;
  };
  const wrapGuardedInvoke = ({
    invoke,
    taskName
  }) => (args) => {
    if (closing) {
      return Promise.reject(new Error("Pool is shut down"));
    }
    const pending = invoke(args);
    if (!hardTimeoutMs)
      return pending;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled)
          return;
        settled = true;
        reject(new Error(`Task hard timeout after ${hardTimeoutMs}ms (${taskName}); pool force-shutdown`));
        closePoolNow();
      }, hardTimeoutMs);
      pending.then((value) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      }, (error) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  };
  const shutdownWithDelay = (delayMs) => {
    if (closePromise)
      return closePromise;
    if (shutdownPromise)
      return shutdownPromise;
    const ms = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
    shutdownPromise = (async () => {
      if (closePromise)
        return await closePromise;
      if (ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (closePromise)
        return await closePromise;
      await closePoolNow();
    })();
    return shutdownPromise;
  };
  const indexedFunctions = listOfFunctions.map((fn, index) => ({
    name: fn.name,
    index,
    timeout: fn.timeout,
    abortSignal: fn.abortSignal
  }));
  const callHandlers = new Map;
  for (const { name } of indexedFunctions) {
    callHandlers.set(name, []);
  }
  for (const worker2 of workers) {
    for (const { name, index, timeout, abortSignal } of indexedFunctions) {
      callHandlers.get(name).push(wrapGuardedInvoke({
        taskName: name,
        invoke: worker2.call({
          fnNumber: index,
          timeout,
          abortSignal
        })
      }));
    }
  }
  const useDirectHandler = (threads ?? 1) === 1 && !usingInliner;
  const buildInvoker = (handlers) => useDirectHandler ? handlers[0] : managerMethod({
    contexts: workers,
    balancer,
    handlers,
    inlinerGate: usingInliner ? {
      index: inlinerIndex,
      threshold: inlinerDispatchThreshold
    } : undefined
  });
  const callEntries = Array.from(callHandlers.entries(), ([name, handlers]) => [name, buildInvoker(handlers)]);
  return {
    shutdown: shutdownWithDelay,
    call: Object.fromEntries(callEntries)
  };
};
var SINGLE_TASK_KEY = "__task__";
var DEFAULT_IMPORT_EXPORT_NAME = "default";
var createSingleTaskPool = (single, options) => {
  const pool = createPool(options ?? {})({
    [SINGLE_TASK_KEY]: single
  });
  return {
    call: pool.call[SINGLE_TASK_KEY],
    shutdown: pool.shutdown
  };
};
var buildTaskDefinitionFromCaller = (input, callerHref, at) => {
  const importedFrom = new URL(callerHref).href;
  const out = {
    ...input,
    id: genTaskID(),
    importedFrom,
    at,
    [endpointSymbol]: true
  };
  out.createPool = (options) => {
    if (RUNTIME_IS_MAIN_THREAD === false) {
      return out;
    }
    return createSingleTaskPool(out, options);
  };
  return out;
};
var buildTaskDefinition = (input, callerOffset) => {
  const [href, at] = getCallerFilePath(callerOffset);
  return buildTaskDefinitionFromCaller(input, href, at);
};
var resolveImportHref = (href, callerHref) => {
  try {
    return new URL(href, callerHref).href;
  } catch {
    return toModuleUrl(href);
  }
};
var createImportedTaskFn = (href, exportName) => {
  let cachedFn;
  let cachedLoad;
  const loadFn = async () => {
    if (cachedFn)
      return cachedFn;
    if (!cachedLoad) {
      cachedLoad = import(href).then((module) => {
        const record = module;
        const selected = exportName === DEFAULT_IMPORT_EXPORT_NAME ? record.default : record[exportName];
        if (typeof selected !== "function") {
          const available = Object.keys(record).join(", ");
          throw new TypeError(`importTask expected export "${exportName}" from "${href}" to be a function. Available exports: ${available || "(none)"}`);
        }
        cachedFn = selected;
        return cachedFn;
      });
    }
    return cachedLoad;
  };
  return async (...args) => {
    const fn = await loadFn();
    return fn(...args);
  };
};
function task(I) {
  return buildTaskDefinition(I, 4);
}
function importTask(options) {
  const [callerHref, at] = getCallerFilePath(3);
  const {
    href,
    name = DEFAULT_IMPORT_EXPORT_NAME,
    ...rest
  } = options;
  const resolvedHref = resolveImportHref(href, callerHref);
  return buildTaskDefinitionFromCaller({
    ...rest,
    f: createImportedTaskFn(resolvedHref, name)
  }, callerHref, at);
}
export {
  workerMainLoop,
  task,
  isMain,
  importTask,
  createPool,
  Envelope
};
