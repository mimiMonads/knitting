import { createPool } from "../../knitting.ts";

export const echoRawString = (value: string) => value;

export const runAliasedRawFunctionPool = async (
  value: string,
): Promise<string> => {
  const pool = createPool({ threads: 1 })({ renamedEcho: echoRawString });

  try {
    return await pool.call.renamedEcho(value);
  } finally {
    await pool.shutdown();
  }
};
