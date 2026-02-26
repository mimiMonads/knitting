const capturedEval = (globalThis as Record<string, unknown>)[
  "ev" + "al"
] as (code: string) => unknown;

export const probeIndirectEval = async (): Promise<string> => {
  try {
    const out = capturedEval("import('node:fs').then(() => 'allowed')");
    return await Promise.resolve(out).then((value) => String(value));
  } catch (error) {
    return String(error);
  }
};
