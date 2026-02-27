import { task } from "../../knitting.ts";

export const runawayCpuLoop = task<void, never>({
  f: () => {
    while (true) {
      // Intentional busy loop for hard-timeout validation.
    }
  },
});

export const addOneLimitProbe = task<number, number>({
  f: (value) => value + 1,
});
