import { PayloadType } from "../types.ts";
import type { QueueListWorker } from "../types.ts";

const PLACE_HOLDER = () => {
  throw ("UNREACHABLE FROM PLACE HOLDER (thread)");
};

export const newSlotNoIndex = () =>
  [
    0,
    ,
    0,
    ,
    PLACE_HOLDER,
    PLACE_HOLDER,
    PayloadType.UNREACHABLE,
  ] as QueueListWorker;


