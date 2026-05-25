export const CACHE_LINE_SIZE = 64;
export const alignToCacheLine = (size) => size + ((CACHE_LINE_SIZE - (size % CACHE_LINE_SIZE)) % CACHE_LINE_SIZE);
export const readCreateSize = (options) => typeof options === "number" ? options : options.size;
export const readCreateName = (options, fallback) => typeof options === "number" ? fallback : options.name ?? fallback;
export const readCreateMode = (options) => typeof options === "number" ? "anonymous" : options.mode ?? "anonymous";
export const expectSharedMemoryName = (name) => {
    if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("shared memory name must be a non-empty string");
    }
    if (name.includes("\0")) {
        throw new TypeError("shared memory name must not contain NUL bytes");
    }
    return name;
};
export const readRequiredCreateName = (options) => {
    if (typeof options === "number" || options.name === undefined) {
        throw new TypeError("named shared memory requires a name");
    }
    return expectSharedMemoryName(options.name);
};
export const expectPositiveSize = (size) => {
    if (!Number.isFinite(size) || size <= 0) {
        throw new RangeError("shared memory size must be positive");
    }
    return alignToCacheLine(Math.trunc(size));
};
export const expectFd = (fd) => {
    if (!Number.isInteger(fd) || fd < 0) {
        throw new RangeError("shared memory fd must be non-negative");
    }
    return fd;
};
export const requireSharedArrayBuffer = (mapping) => {
    if (mapping.sab !== undefined)
        return mapping.sab;
    throw new TypeError(`${mapping.runtime} mapping is ${mapping.kind}; a native SAB wrapper is required`);
};
