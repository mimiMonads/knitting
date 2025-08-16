import type { run as mitataRun } from "mitata";

const json = { debug: false, samples: false };

export const format = process.argv.includes("--json")
  ? {
    json,
  }
  : "markdown";

type Returned = Awaited<ReturnType<typeof mitataRun>> & {
  layout: ({
    name: string | null;
  })[];
};

export const print = process.argv.includes("--json")
  ? (jsonString: string) => {
    const user = JSON.parse(jsonString) as Returned;
    const layouts = user.layout;
    const endMap = new Map<string, { name: string; stats: object }[]>();

    for (const { group, runs, alias } of user.benchmarks) {
      const key = layouts[group as number].name!;
      const arr = endMap.get(key) ?? [];

      // Drop heavy fields (like samples) to keep JSON compact:
      const {
        kind,
        min,
        max,
        p25,
        p50,
        p75,
        p99,
        p999,
        avg,
        ticks,
        heap,
        gc,
        // samples, counters, // purposely omitted
      } = runs[0].stats;

      arr.push({
        name: alias,
        stats: {
          kind,
          min,
          max,
          p25,
          p50,
          p75,
          p99,
          p999,
          avg,
          ticks,
          heap,
          gc,
        },
      });

      endMap.set(key, arr);
    }

    console.log(JSON.stringify(Object.fromEntries(endMap), null, 2));
  }
  : (s: string) => console.log(s);
type JsonBench = {
  [key: string]: (
    {
      debug: string;
      ticks: number;
      samples: number[];
      counters?: object;
      kind: "fn" | "iter" | "yield";
      min: number;
      max: number;
      avg: number;
      p25: number;
      p50: number;
      p75: number;
      p99: number;
      p999: number;
      gc?: { avg: number; min: number; max: number; total: number };
      heap?: { avg: number; min: number; max: number; total: number };
    }
  )[];
};
