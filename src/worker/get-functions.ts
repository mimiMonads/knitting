import type { Args, ComposedWithKey, ReturnFixed } from "../types.ts";
import { endpointSymbol } from "../common/task-symbol.ts";

type GetFunctionParams = {
  list: string[];
  ids: number[];
  at: number[];
  isWorker: boolean;
};

export const getFunctions = async (
  { list, ids, at }: GetFunctionParams,
) => {

  const isUnique = at.length === 1 && ids.length >  1

  const results = await Promise.all(
    list
      .map((string) => {
        const url = new URL(string).href;

        if (url.includes("://")) return url;

        return "file://" + new URL(string).href;
      })
      .map(async (imports) => {
        const module = await import(imports);
        return Object.entries(module)
          .filter(
            ([_, value]) =>
              value != null && typeof value === "object" &&
              //@ts-ignore Reason -> trust me
              value?.[endpointSymbol] === true,
          )
          .map(([name, value]) => ({
            //@ts-ignore Reason -> trust me
            ...value,
            name,
          })) as unknown as ComposedWithKey[];
      }),
  );

  // Flatten the results, filter by IDs, and sort
  const flattenedResults = results
    .flat()
    .filter((obj) => ids.includes(obj.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return flattenedResults as unknown as ComposedWithKey[];
};

export type GetFunctions = ReturnType<typeof getFunctions>;
