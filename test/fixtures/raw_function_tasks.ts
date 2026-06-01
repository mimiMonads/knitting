import { createPool } from "../../knitting.ts";

export const rawAdd = ([left, right]: [number, number]) => left + right;

export function rawDouble(value: number): number {
  return value * 2;
}

export const callRawFunctionPool = async () => {
  const pool = createPool({ threads: 1 })({ rawAdd, rawDouble });

  try {
    return [
      await pool.call.rawAdd([2, 3]),
      await pool.call.rawDouble(21),
    ] as const;
  } finally {
    await pool.shutdown();
  }
};
