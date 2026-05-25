export default class RingQueue<T> implements Iterable<T> {
    #private;
    constructor(capacity?: number);
    get size(): number;
    get isEmpty(): boolean;
    get capacity(): number;
    clear(): void;
    peek(): T | undefined;
    /** Ensure internal capacity >= requested (rounds up to next power of two). */
    reserve(minCapacity: number): void;
    /**
     * Push to back
     * Always succeeds (grows if full)
     */
    push(value: T): true;
    /**
     * Push to front (unshift)
     * Always succeeds (grows if full)
     */
    unshift(value: T): true;
    /**
     * Pop from front (shift)
     */
    shift(): T | undefined;
    /**
     * Pop from front (shift) without clearing the slot.
     * Use only for internal pooled-object queues where retaining references is acceptable.
     */
    shiftNoClear(): T | undefined;
    [Symbol.iterator](): Generator<T, void, void>;
    toArray(): T[];
    get [Symbol.toStringTag](): string;
}
