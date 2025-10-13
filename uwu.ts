// array-vs-linked-list-shift.mjs
import { bench, run } from "mitata";

// LinkedList.ts — modern, iterable, tail-aware singly linked list

type Node<T> = { value: T; next: Node<T> | null };

export default class LinkedList<T> implements Iterable<T> {
  #head: Node<T> | null = null;
  #tail: Node<T> | null = null;
  #size = 0;

  constructor(iterable?: Iterable<T>) {
    if (iterable) { for (const v of iterable) this.push(v); }
  }

  get size(): number {
    return this.#size;
  }
  get isEmpty(): boolean {
    return this.#size === 0;
  }

  push(value: T): void {
    const node: Node<T> = { value, next: null };
    if (!this.#head) {
      this.#head = this.#tail = node;
    } else {
      this.#tail!.next = node;
      this.#tail = node;
    }
    this.#size++;
  }

  unshift(value: T): void {
    const node: Node<T> = { value, next: this.#head };
    this.#head = node;
    if (!this.#tail) this.#tail = node;
    this.#size++;
  }

  shift(): T | undefined {
    if (!this.#head) return undefined;
    const { value, next } = this.#head;
    this.#head = next;
    if (!this.#head) this.#tail = null;
    this.#size--;
    return value;
  }

  peek(): T | undefined {
    return this.#head?.value;
  }

  clear(): void {
    this.#head = this.#tail = null;
    this.#size = 0;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (const v of this) out.push(v);
    return out;
  }

  [Symbol.iterator](): Iterator<T> {
    let cur = this.#head;
    return {
      next(): IteratorResult<T> {
        if (!cur) return { done: true, value: undefined as any };
        const value = cur.value;
        cur = cur.next;
        return { done: false, value };
      },
    };
  }

  get [Symbol.toStringTag](): string {
    return `LinkedList(size=${this.#size})`;
  }

  static from<U>(iterable: Iterable<U>): LinkedList<U> {
    return new LinkedList(iterable);
  }
}

// --- Test bodies ported 1:1 from MeasureThat (including thresholds) ---
// Linked List test
function testLinkedList_MeasureThat() {
  const list = new LinkedList();

  let x = 10000;
  while (x--) list.unshift(x);
  // Original benchmark compares node object to number (< 1000).
  // This is intentionally preserved for fidelity.
  // It will usually exit immediately due to non-numeric comparison.
  while (list.shift() < 1000) {}
}

// Array test
function testArray_MeasureThat() {
  const array = [];
  let x = 10000;
  while (x--) array.unshift(x);
  while (array.shift() < 10000) {}
}
// --- Benchmarks ---
bench("Linked List (MeasureThat)", () => {
  testLinkedList_MeasureThat();
});

bench("Array (MeasureThat)", () => {
  testArray_MeasureThat();
});

// Optional: a "fixed" variant for curiosity (not part of the faithful replication).
// Uncomment to compare.
// function testLinkedList_Fixed() {
//   const list = new LinkedList();
//   let x = 10000;
//   while (x--) list.unshift(x);
//   // Shift returns node; compare using node.data and mirror the Array threshold.
//   let node;
//   while ((node = list.shift()) && node.data < 10000) {}
// }
// bench('Linked List (Fixed: compare node.data, <10000)', () => {
//   testLinkedList_Fixed();
// });

await run();
