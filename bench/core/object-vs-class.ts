import { bench, group, run as mitataRun } from "mitata";
import { format, print } from "../ulti/json-parse.ts";

type PlainRecord = {
  a: number;
  b: number;
  sum(delta: number): number;
};

class ClassRecord {
  a: number;
  b: number;

  constructor(a: number, b: number) {
    this.a = a;
    this.b = b;
  }

  sum(delta: number): number {
    return this.a + this.b + delta;
  }
}

const makePlainRecord = (a: number, b: number): PlainRecord => ({
  a,
  b,
  sum(delta: number) {
    return this.a + this.b + delta;
  },
});

const plain = makePlainRecord(1, 2);
const klass = new ClassRecord(1, 2);
const plainBatch = Array.from({ length: 32 }, (_, i) => makePlainRecord(i, i + 1));
const classBatch = Array.from({ length: 32 }, (_, i) => new ClassRecord(i, i + 1));
const plainBoundSum = plain.sum.bind(plain);
const classBoundSum = klass.sum.bind(klass);

let sink = 0;

group("object-vs-class", () => {
  bench("plain object property read", () => {
    sink = (sink + plain.a + plain.b) | 0;
  });

  bench("class instance property read", () => {
    sink = (sink + klass.a + klass.b) | 0;
  });

  bench("plain object method call", () => {
    sink = (sink + plain.sum(1)) | 0;
  });

  bench("class instance method call", () => {
    sink = (sink + klass.sum(1)) | 0;
  });

  bench("plain object bound method call", () => {
    sink = (sink + plainBoundSum(1)) | 0;
  });

  bench("class instance bound method call", () => {
    sink = (sink + classBoundSum(1)) | 0;
  });

  bench("plain object loop read (32)", () => {
    let total = 0;
    for (let i = 0; i < plainBatch.length; i++) {
      const item = plainBatch[i]!;
      total += item.a + item.b;
    }
    sink = (sink + total) | 0;
  });

  bench("class instance loop read (32)", () => {
    let total = 0;
    for (let i = 0; i < classBatch.length; i++) {
      const item = classBatch[i]!;
      total += item.a + item.b;
    }
    sink = (sink + total) | 0;
  });

  bench("plain object loop call (32)", () => {
    let total = 0;
    for (let i = 0; i < plainBatch.length; i++) {
      total += plainBatch[i]!.sum(1);
    }
    sink = (sink + total) | 0;
  });

  bench("class instance loop call (32)", () => {
    let total = 0;
    for (let i = 0; i < classBatch.length; i++) {
      total += classBatch[i]!.sum(1);
    }
    sink = (sink + total) | 0;
  });

  bench("plain object loop cached fn + call (32)", () => {
    let total = 0;
    for (let i = 0; i < plainBatch.length; i++) {
      const item = plainBatch[i]!;
      const fn = item.sum;
      total += fn.call(item, 1);
    }
    sink = (sink + total) | 0;
  });

  bench("class instance loop cached fn + call (32)", () => {
    let total = 0;
    for (let i = 0; i < classBatch.length; i++) {
      const item = classBatch[i]!;
      const fn = item.sum;
      total += fn.call(item, 1);
    }
    sink = (sink + total) | 0;
  });
});

await mitataRun({
  format,
  print,
});

if (sink === Number.MIN_SAFE_INTEGER) {
  console.log("unreachable", sink);
}
