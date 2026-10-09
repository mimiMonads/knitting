import { task } from "../../knitting.ts";
import { StringReference } from "../../experimental.ts";
export const echoStringReference = task<StringReference, StringReference>({
  f: (reference) => {
    try {
      reference.toString();
      return reference.clone();
    } finally {
      reference.release();
    }
  },
});
export const failStringReference = task<StringReference, void>({
  f: (reference) => {
    reference.release();
    throw new Error("expected reference failure");
  },
});
