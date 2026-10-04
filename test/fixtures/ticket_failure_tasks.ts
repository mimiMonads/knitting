import { task } from "../../knitting.ts";

/** An uncaught event-loop error kills the worker, unlike a rejected task. */
export const crashTicketWorker = task<void, number>({
  f: () => {
    setTimeout(() => {
      throw new Error("ticket test worker crash");
    }, 0);
    return new Promise<number>(() => {});
  },
});

export const rejectTicketTask = task<void, number>({
  f: () => {
    throw new Error("ordinary task rejection");
  },
});
