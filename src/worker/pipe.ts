import {
  createSharedMemoryTransport,
  OP,
} from "../ipc/transport/shared-memory";
import type { WorkerData } from "../runtime/pool";
import type { CreateWorkerRxQueue } from "./rx-queue";

enum PipeState {
  "waiting" = 0,
  "working" = 0,
  "idle" = 1,
}

export const pipe = ({
  sab,
  handler: {
    enqueue,
    serviceOne,
    hasCompleted,
    write,
    allDone,
    serviceOneImmediate,
    hasPending,
    blockingResolve,
  },
}: {
  sab: WorkerData["sab"];
  handler: CreateWorkerRxQueue;
}) => {
  const signals = createSharedMemoryTransport({
    sabObject: {
      sharedSab: sab,
    },
    isMain: false,
    thread: 0,
  });

  const { op } = signals;

  return async () => {
    while (true) {
      switch (op[0]) {
        case OP.AllTasksDone:
        case OP.WaitingForMore:
        case OP.ErrorThrown: {
          return PipeState.idle
        }
        case OP.WakeUp: {
          return PipeState.waiting;
        }

        case OP.HighPriorityResolve: {
          await blockingResolve();
          return PipeState.working;
        }

        case OP.WorkerWaiting: {
          if (hasPending()) {
            await serviceOneImmediate();
            return PipeState.working;
          }
          return PipeState.idle;
        }

        case OP.MainReadyToRead: {
          if (hasCompleted()) {
            write();
            return PipeState.working;;
          }

          await serviceOne();

          if (allDone()) {
            op[0] = OP.AllTasksDone;
            return PipeState.idle;;
          }

          return PipeState.working;;
        }
        case OP.MainSend: {
          enqueue();
          return PipeState.working;
        }

        case OP.FastResolve:
        case OP.MainStop: {
          return PipeState.idle;
        }
      }
    }
  };
};
