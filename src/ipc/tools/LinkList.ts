type ID = number;
interface Node<T extends [ID, ...any[]]>  { value: T; next: Node<T> | null };

export default class LinkedList<T> implements Iterable<T> {
  #buf: (T | undefined)[];
  #mask: number;
  #head = 0;
  #tail = 0;
  #size = 0;

  constructor(capacity = 512) {
    let cap = 2;
    while (cap < capacity) cap <<= 1;
    this.#buf = new Array<T | undefined>(cap);
    this.#mask = cap - 1;
  }

  get size(): number {
    return this.#size;
  }

  get isEmpty(): boolean {
    return this.#size === 0;
  }

  get capacity(): number {
    return this.#mask + 1;
  }

  clear(): void {
    // Keep buffer allocated; reset pointers (fast)
    // (optional) also drop references to help GC if you want:
    // for (let i = 0; i < this.#size; i++) this.#buf[(this.#head + i) & this.#mask] = undefined;

    this.#head = 0;
    this.#tail = 0;
    this.#size = 0;
  }

  peek(): T | undefined {
    return this.#size === 0 ? undefined : (this.#buf[this.#head] as T);
  }

  /** Ensure internal capacity >= requested (rounds up to next power of two). */
  reserve(minCapacity: number): void {
    if (minCapacity <= this.capacity) return;
    let cap = this.capacity;
    while (cap < minCapacity) cap <<= 1;
    this.#growTo(cap);
  }

  // --- hot path internal ---
  #growIfFull(): void {
    if (this.#size !== (this.#mask + 1)) return;
    this.#growTo((this.#mask + 1) << 1);
  }

  #growTo(newCap: number): void {
    const oldBuf = this.#buf;
    const oldMask = this.#mask;
    const n = this.#size;

    const next = new Array<T | undefined>(newCap);

    // copy logical order [head..tail) into [0..n)
    // this keeps iteration and subsequent ops cache-friendly
    for (let i = 0; i < n; i++) {
      next[i] = oldBuf[(this.#head + i) & oldMask];
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
  push(value: T): true {
    this.#growIfFull();
    this.#buf[this.#tail] = value;
    this.#tail = (this.#tail + 1) & this.#mask;
    this.#size++;
    return true;
  }

  /**
   * Push to front (unshift)
   * Always succeeds (grows if full)
   */
  unshift(value: T): true {
    this.#growIfFull();
    this.#head = (this.#head - 1) & this.#mask;
    this.#buf[this.#head] = value;
    this.#size++;
    return true;
  }

  /**
   * Pop from front (shift)
   */
  shift(): T | undefined {
    if (this.#size === 0) return undefined;
    const v = this.#buf[this.#head] as T;
    this.#buf[this.#head] = undefined; // help GC
    this.#head = (this.#head + 1) & this.#mask;
    this.#size--;
    return v;
  }

  *[Symbol.iterator](): Generator<T, void, void> {
    const buf = this.#buf;
    const mask = this.#mask;
    let idx = this.#head;
    let i = 0;
    const n = this.#size;

    while (i < n) {
      // values should never be undefined inside active range, but keep it safe
      const v = buf[idx];
      if (v !== undefined) yield v as T;
      idx = (idx + 1) & mask;
      i++;
    }
  }

  toArray(): T[] {
    // faster than Array.from(this) in some cases because it avoids iterator overhead,
    // but keep iterator version if you prefer simplicity.
    const out = new Array<T>(this.#size);
    const buf = this.#buf;
    const mask = this.#mask;
    let idx = this.#head;

    for (let i = 0; i < out.length; i++) {
      out[i] = buf[idx] as T;
      idx = (idx + 1) & mask;
    }
    return out;
  }

  get [Symbol.toStringTag](): string {
    return `RingQueue(size=${this.#size}, cap=${this.capacity})`;
  }
}