import { task } from "../../knitting.ts";

/** Paired with `task_id_decoys.ts` to make a pool span two modules. */
export const partner = task<number, number>({ f: (value) => value + 1000 });
