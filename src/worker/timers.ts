type PauseOptions = {
  pauseInNanosecons?: number;
};

export const pause = ({ pauseInNanosecons }: PauseOptions) => {
  const forNanoseconds = pauseInNanosecons ?? 300;

  return "pause" in Atomics ? () => Atomics.pause(forNanoseconds) : () => {};
};

export const sleepUntilChanged = (
  sab: Int32Array,
  pause: () => void,
) => {
  const status = sab;

  return (
    at: number,
    value: number,
    usTime: number,
  ) => {
    const until = performance.now() + (usTime / 1000);

    do {
      if (Atomics.load(status, at) !== value) return false;
      pause();
    } while (
      performance.now() < until
    );

    return true;
  };
};
