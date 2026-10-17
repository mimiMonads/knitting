/** One owner-written word per cache line; allocated only for peer admission. */
export const UNRAVEL_OWNERSHIP_STRIDE = 16;

export const createUnravelOwnership = (buffer: SharedArrayBuffer, id: number) => {
  const counts = new Int32Array(buffer);
  const index = id * UNRAVEL_OWNERSHIP_STRIDE;
  if (counts.length % UNRAVEL_OWNERSHIP_STRIDE !== 0 ||
      !Number.isInteger(id) || id < 0 || index >= counts.length) {
    throw new RangeError("Invalid Unravel ownership layout or worker id");
  }
  return {
    publish: (owned: number) => Atomics.store(counts, index, owned),
    // A concurrent advisory snapshot, not a reservation or a resource limit.
    total: () => {
      let total = 0;
      for (let i = 0; i < counts.length; i += UNRAVEL_OWNERSHIP_STRIDE) {
        total += Atomics.load(counts, i);
      }
      return total;
    },
  };
};

export type UnravelOwnership = ReturnType<typeof createUnravelOwnership>;
