import { importTask, task } from "../../knitting.ts";

export const addOnePromise = task<Promise<number> | number, number>({
  f: async (value) => value + 1,
});

const importedFunctionsHref = new URL(
  "./imported_functions.ts",
  import.meta.url,
).href;

export const addOneViaImportTask = importTask<number, number>({
  href: importedFunctionsHref,
  name: "addOne",
});
