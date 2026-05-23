import { importTask, isMain, task } from "../../knitting.ts";

export const addOnePromise = task<Promise<number> | number, number>({
  f: async (value) => value + 1,
});

export const addOneViaImportTask = importTask<number, number>({
  href: "./imported_functions.ts",
  name: "addOne",
});

export const reportIsMain = task<void, boolean>({
  f: () => isMain,
});
