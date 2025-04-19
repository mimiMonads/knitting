import { bench, boxplot, group, run as mitataRun, summary } from "mitata";
import { createThreadPool } from "../main.ts";
import { bbb } from "./functions.ts";
import { deserialize, serialize } from "node:v8";

const inLine = bbb;
const { terminateAll, fastCallFunction, callFunction, send } = createThreadPool(
  {
    threads: 1,
  },
)({
  inLine,
});
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

boxplot(async () => {
  let nulled = null,
    undefinedvalue = undefined,
    bool = true,
    string = "uwuwuwuwuw",
    obj = { hello: "hi" },
    hugeBin = BigInt(
      "0b11111111111111111111111111111111111111111111111111111",
    ),
    num = 222222;

  bench("null", () => {
    deserialize(serialize(nulled));
  });
  bench("num", () => {
    deserialize(serialize(num));
  });
  bench("numBug", () => {
    deserialize(serialize(hugeBin));
  });
  bench("undefined", () => {
    deserialize(serialize(undefinedvalue));
  });
  bench("bool", () => {
    deserialize(serialize(bool));
  });
  bench("string", () => {
    deserialize(serialize(string));
  });
  bench("stringText", () => {
    textDecoder.decode(textEncoder.encode(string));
  });

  bench("obj", () => {
    deserialize(serialize(obj));
  });

  bench("obj uwu", () => {
    JSON.parse(textDecoder.decode(textEncoder.encode(JSON.stringify(obj))));
  });

  group("1", () => {
    bench("nop", async () => {
      const arr = [
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
        callFunction.inLine(),
      ];

      send();

      await Promise.all(arr);

      await fastCallFunction.inLine();
    });

    summary(() => {
      bench("main", async () => {
        await inLine.f();
      });

      bench(" 1 thread -> 1", async () => {
        await fastCallFunction.inLine();
      });

      bench(" 1 thread -> 2", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 3", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });

      bench(" 1 thread -> 4", async () => {
        const arr = [
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
          callFunction.inLine(),
        ];

        send();

        await Promise.all(arr);
      });
    });
  });
});
await mitataRun();
await terminateAll();
