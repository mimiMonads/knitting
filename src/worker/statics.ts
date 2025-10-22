import { PayloadType } from "../ipc/protocol/codec";
import LinkList from "../ipc/tools/LinkList";
import type { QueueListWorker } from "../runtime/tx-queue";

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


  
  export const toWork = new LinkList<QueueListWorker>();
  export const completedFrames = new LinkList<QueueListWorker>();
  export const errorFrames = new LinkList<QueueListWorker>();
  export const optimizedFrames = new LinkList<QueueListWorker>();

