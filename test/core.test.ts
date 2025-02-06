import { assertEquals } from "jsr:@std/assert";
import { createContext } from "../src/main.ts";
import { fixedPoint, toListAndIds } from "../src/fixpoint.ts";

export const a = fixedPoint({
  args: "uint8",
  f: async (a) => a,
});

//@ts-ignore
const VALUE = Uint8Array.from("Hello");

Deno.test("fixpoint", async () => {
  assertEquals(
    a.importedFrom.includes("/test/core.test.ts"),
    true,
  );
});

Deno.test("fixpoint", async () => {
  const promisesMap = new Map();
  const { ids, list } = toListAndIds({ a });
  const ctx = createContext({
    promisesMap,
    ids,
    list,
  });
   //ctx.kills();
});
