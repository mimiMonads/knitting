import { bench, group, run as mitataRun } from "mitata";
import { format, print } from "../ulti/json-parse.ts";
import {
  lock2,
  makeTask,
  type Task,
} from "../../src/memory/lock.ts";

class CustomPayload {
  constructor(
    public n: number,
    public label: string,
  ) {}
}

const makeLock = () => lock2({});

const ackAll = (registry: ReturnType<typeof makeLock>) => {
  Atomics.store(registry.workerBits, 0, registry.hostBits[0]);
};

const roundtrip = (registry: ReturnType<typeof makeLock>, task: Task) => {
  ackAll(registry);
  registry.encode(task);
  registry.decode();
  registry.resolved.clear();
};

const lock = makeLock();

const plainObjectTask = makeTask();
const plainObjectValue = { a: 1, b: "x", c: true };
plainObjectTask.value = plainObjectValue;

const errorTask = makeTask();
const errorValue = new TypeError("payload-hardening benchmark");
errorTask.value = errorValue;

const customTask = makeTask();

group("payload-hardening", () => {
  bench("roundtrip plain object", () => {
    plainObjectTask.value = plainObjectValue;
    roundtrip(lock, plainObjectTask);
  });

  bench("roundtrip error", () => {
    errorTask.value = errorValue;
    roundtrip(lock, errorTask);
  });

  bench("encode custom class (strict reject)", () => {
    ackAll(lock);
    customTask.value = new CustomPayload(42, "custom");
    lock.encode(customTask);
    lock.decode();
    lock.resolved.clear();
  });
});

await mitataRun({
  format,
  print,
});
