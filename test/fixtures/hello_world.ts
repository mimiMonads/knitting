import { task } from "../../knitting.ts";

export const hello = task({
  f: () => "hello ",
});

export const world = task({
  f: (args: string) => args + " world!",
});
