import { bench, group, run as mitataRun } from "mitata";
import LinkedList from "../../src/ipc/tools/LinkList.ts";
import {
  PromisePayloadMarker,
  TaskIndex,
  type Lock2,
  type Task,
} from "../../src/memory/lock.ts";
import { createHostTxQueue } from "../../src/runtime/tx-queue.ts";
import { format, print } from "../ulti/json-parse.ts";

const NOOP = () => {};

class TxLockMock {
  readonly #capacity: number;
  #inFlight: Task[] = [];
  public lastEncoded: Task | undefined;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  public encode = (task: Task): boolean => {
    if (this.#inFlight.length >= this.#capacity) return false;
    this.#inFlight.push(task);
    this.lastEncoded = task;
    return true;
  };

  public encodeManyFrom = (list: LinkedList<Task>): number => {
    let encoded = 0;
    while (this.#inFlight.length < this.#capacity) {
      const task = list.shift();
      if (!task) break;
      this.#inFlight.push(task);
      this.lastEncoded = task;
      encoded++;
    }
    return encoded;
  };

  public takeAllInFlight = (): Task[] => {
    const tasks = this.#inFlight;
    this.#inFlight = [];
    return tasks;
  };
}

class ReturnLockMock {
  #pending: Task[] = [];

  public encode = (task: Task): boolean => {
    this.#pending.push(task);
    return true;
  };

  public resolveHost = (
    { queue, onResolved }: { queue: Task[]; onResolved?: (task: Task) => void },
  ) => {
    return (): number => {
      let resolved = 0;
      while (this.#pending.length > 0) {
        const frame = this.#pending.shift() as Task;
        const slot = queue[frame[TaskIndex.ID]];
        slot.value = frame.value;
        slot[TaskIndex.FlagsToHost] = frame[TaskIndex.FlagsToHost];

        if (slot[TaskIndex.FlagsToHost] === 0) {
          slot.resolve(slot.value);
        } else {
          slot.reject(slot.value);
          slot[TaskIndex.FlagsToHost] = 0;
        }

        onResolved?.(slot);
        resolved++;
      }
      return resolved;
    };
  };
}

class TxQueueHarness {
  readonly #txLock: TxLockMock;
  readonly #returnLock: ReturnLockMock;
  readonly #queue: ReturnType<typeof createHostTxQueue>;
  readonly #enqueueTask: (raw: unknown) => Promise<unknown>;

  constructor(max: number, txCapacity: number) {
    this.#txLock = new TxLockMock(txCapacity);
    this.#returnLock = new ReturnLockMock();
    this.#queue = createHostTxQueue({
      max,
      lock: this.#txLock as unknown as Lock2,
      returnLock: this.#returnLock as unknown as Lock2,
    });
    this.#enqueueTask = this.#queue.enqueue(1);
  }

  public enqueueBurst = (count: number): void => {
    for (let i = 0; i < count; i++) {
      void this.#enqueueTask(i).catch(NOOP);
    }
  };

  public enqueueSingle = (): Task => {
    void this.#enqueueTask(1).catch(NOOP);
    const task = this.#txLock.lastEncoded;
    if (!task) throw new Error("No encoded task available");
    return task;
  };

  public cycleUntilIdle = (): void => {
    let guard = 0;
    while (!this.#queue.txIdle() && guard++ < 1024) {
      const inFlight = this.#txLock.takeAllInFlight();
      for (const task of inFlight) {
        task[TaskIndex.FlagsToHost] = 0;
        this.#returnLock.encode(task);
      }

      this.#queue.completeFrame();

      while (this.#queue.hasPendingFrames() && this.#queue.flushToWorker()) {
        // flush until there is no space or no pending frames
      }
    }

    if (!this.#queue.txIdle()) {
      this.#queue.rejectAll("bench cleanup");
    }
  };

  public settlePromisePayloadRejected = (): void => {
    const task = this.enqueueSingle();
    (task as Task & { [PromisePayloadMarker]?: true })[PromisePayloadMarker] =
      true;
    this.#queue.settlePromisePayload(task, {
      status: "rejected",
      reason: "bench rejection",
    });
    this.#txLock.takeAllInFlight();
  };
}

const directHarness = new TxQueueHarness(64, 64);
const overflowHarness = new TxQueueHarness(256, 32);
const promiseHarness = new TxQueueHarness(64, 64);

group("tx-queue (workerless)", () => {
  bench("enqueue + complete (32)", () => {
    directHarness.enqueueBurst(32);
    directHarness.cycleUntilIdle();
  });

  bench("overflow + flush + complete (128)", () => {
    overflowHarness.enqueueBurst(128);
    overflowHarness.cycleUntilIdle();
  });

  bench("settlePromisePayload rejected (1)", () => {
    promiseHarness.settlePromisePayloadRejected();
  });
});

await mitataRun({
  format,
  print,
});
