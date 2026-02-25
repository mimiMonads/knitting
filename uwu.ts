import { spawn } from "node:child_process";
import { createPool, isMain, task } from "./knitting.ts";

async function echoFromCli(message: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(
      isWindows ? "cmd.exe" : "echo",
      isWindows ? ["/d", "/s", "/c", "echo", message] : [message],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `echo failed with exit code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export const hello = task({
    abortSignal: {
      hasAborted: true,
    },
    f: (_: undefined , tbh ) => {

        tbh.hasAborted()
        let total = performance.now()
        for (let index = 0; index < 10; index++) {
            total += performance.now()
        }

        return total
    }
});

export const echoCli = task({
  f: async (message: string) => await echoFromCli(message),
});

const pool = createPool({
  permison: { mode: "strict"}
})({
  hello,
  echoCli,
});


if (isMain) {
  // const arr = Array.from({ length: 10 }, () => pool.call.hello());

  // const first = await Promise.race(
  //   arr.map((p, i) =>
  //     p.then(
  //       (value) => ({ i, p, ok: true as const, value }),
  //       (error) => ({ i, p, ok: false as const, error }),
  //     ),
  //   ),
  // );

  // arr.forEach((p) => {
  //   if (p !== first.p) p.reject?.(new Error("Cancelled after race"));
  // });

  // if (!first.ok) throw first.error;
  // console.log("winner:", first.value);
  // console.log(await Promise.allSettled(arr));
  console.log("cli echo:", await pool.call.echoCli("hello from the command line"));

  await pool.shutdown();
}
