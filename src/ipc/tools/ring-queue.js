;
export default class RingQueue {
    #buf;
    #mask;
    #head = 0;
    #tail = 0;
    #size = 0;
    constructor(capacity = 512) {
        let cap = 2;
        while (cap < capacity)
            cap <<= 1;
        // Keep the array packed (avoid holey elements in hot queue paths).
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
        // Keep buffer allocated; reset pointers (fast)
        // (optional) also drop references to help GC if you want:
        // for (let i = 0; i < this.#size; i++) this.#buf[(this.#head + i) & this.#mask] = null;
        this.#head = 0;
        this.#tail = 0;
        this.#size = 0;
    }
    peek() {
        return this.#size === 0 ? undefined : this.#buf[this.#head];
    }
    /** Ensure internal capacity >= requested (rounds up to next power of two). */
    reserve(minCapacity) {
        if (minCapacity <= this.capacity)
            return;
        let cap = this.capacity;
        while (cap < minCapacity)
            cap <<= 1;
        this.#growTo(cap);
    }
    // --- hot path internal ---
    #growIfFull() {
        if (this.#size !== (this.#mask + 1))
            return;
        this.#growTo((this.#mask + 1) << 1);
    }
    #growTo(newCap) {
        const oldBuf = this.#buf;
        const oldCap = this.#mask + 1;
        const n = this.#size;
        const next = new Array(newCap).fill(null);
        const head = this.#head;
        const firstLen = Math.min(n, oldCap - head);
        // copy [head..end)
        for (let i = 0; i < firstLen; i++) {
            next[i] = oldBuf[head + i];
        }
        // copy [0..remaining)
        for (let i = firstLen; i < n; i++) {
            next[i] = oldBuf[i - firstLen];
        }
        this.#buf = next;
        this.#mask = newCap - 1;
        this.#head = 0;
        this.#tail = n;
    }
    /**
     * Push to back
     * Always succeeds (grows if full)
     */
    push(value) {
        this.#growIfFull();
        const buf = this.#buf;
        const mask = this.#mask;
        const tail = this.#tail;
        buf[tail] = value;
        this.#tail = (tail + 1) & mask;
        this.#size++;
        return true;
    }
    /**
     * Push to front (unshift)
     * Always succeeds (grows if full)
     */
    unshift(value) {
        this.#growIfFull();
        const buf = this.#buf;
        const mask = this.#mask;
        const head = (this.#head - 1) & mask;
        this.#head = head;
        buf[head] = value;
        this.#size++;
        return true;
    }
    /**
     * Pop from front (shift)
     */
    shift() {
        const size = this.#size;
        if (size === 0)
            return undefined;
        const head = this.#head;
        const buf = this.#buf;
        const v = buf[head];
        buf[head] = null; // help GC while keeping packed elements
        this.#head = (head + 1) & this.#mask;
        this.#size = size - 1;
        return v;
    }
    /**
     * Pop from front (shift) without clearing the slot.
     * Use only for internal pooled-object queues where retaining references is acceptable.
     */
    shiftNoClear() {
        const size = this.#size;
        if (size === 0)
            return undefined;
        const head = this.#head;
        const v = this.#buf[head];
        this.#head = (head + 1) & this.#mask;
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
            // values should never be null inside active range, but keep it safe
            const v = buf[idx];
            if (v !== null)
                yield v;
            idx = (idx + 1) & mask;
            i++;
        }
    }
    toArray() {
        // faster than Array.from(this) in some cases because it avoids iterator overhead,
        // but keep iterator version if you prefer simplicity.
        const out = new Array(this.#size);
        const buf = this.#buf;
        const mask = this.#mask;
        let idx = this.#head;
        for (let i = 0; i < out.length; i++) {
            out[i] = buf[idx];
            idx = (idx + 1) & mask;
        }
        return out;
    }
    get [Symbol.toStringTag]() {
        return `RingQueue(size=${this.#size}, cap=${this.capacity})`;
    }
}
