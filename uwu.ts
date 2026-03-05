import { createPool, importTask, isMain } from "./knitting.ts";

const REMOTE_TASKS_URL = "https://knittingdocs.netlify.app/example-task.mjs";

export const addFromWeb = importTask<[number, number], number>({
  href: REMOTE_TASKS_URL,
  name: "add",
});

export const wordStatsFromWeb = importTask<
  { text: string },
  { words: number; chars: number }
>({
  href: REMOTE_TASKS_URL,
  name: "wordStats",
});

const pool = createPool({ threads: 2 })({
  addFromWeb,
  wordStatsFromWeb,
});

if (isMain) {
  try {
    const [sum, stats] = await Promise.all([
      pool.call.addFromWeb([8, 5]),
      pool.call.wordStatsFromWeb({ text: "hello from remote tasks" }),
    ]);

    console.log("sum from web:", sum);
    console.log("word stats from web:", stats);
  } finally {
    await pool.shutdown();
  }
}
