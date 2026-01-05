type ID = number;
interface Node<T extends [ID, ...any[]]>  { value: T; next: Node<T> | null };

export default class LinkedList<T extends [ID, ...any[]]>
  implements Iterable<T> {
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

  /** Remove by first-tuple element (ID) */
  remove(id: ID): T | undefined {
    if (!this.#head) return undefined;

    if (this.#head.value[0] === id) {
      return this.shift();
    }

    let prev = this.#head;
    let curr = this.#head.next;

    while (curr) {
      if (curr.value[0] === id) {
        prev.next = curr.next;
        if (curr === this.#tail) this.#tail = prev;
        this.#size--;
        return curr.value;
      }
      prev = curr;
      curr = curr.next;
    }
    return undefined;
  }

  *[Symbol.iterator](): Generator<T, void, void> {
    let cur = this.#head;
    while (cur) {
      yield cur.value;
      cur = cur.next;
    }
  }

  get [Symbol.toStringTag](): string {
    return `LinkedList(size=${this.#size})`;
  }

  static from<U extends [ID, ...any[]]>(iterable: Iterable<U>): LinkedList<U> {
    return new LinkedList(iterable);
  }
}
