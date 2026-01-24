type PauseOptions = {
  pauseInNanoseconds?: number;
};

const DEFAULT_PAUSE_TIME = 300;

export const whilePausing = ({ pauseInNanoseconds }: PauseOptions) => {
  const forNanoseconds = pauseInNanoseconds ?? DEFAULT_PAUSE_TIME;

  return "pause" in Atomics ? () => Atomics.pause(forNanoseconds) : () => {};
};

export const pauseGeneric = whilePausing({});

export const sleepUntilChanged = (
  {
    at,
    opView,
    pauseInNanoseconds,
    rxStatus,
    txStatus,
  }: {
    opView: Int32Array;
    rxStatus: Int32Array;
    txStatus: Int32Array;
    pauseInNanoseconds?: number;
    at: number;
  },
) => {
  const pause = pauseInNanoseconds
    ? whilePausing({ pauseInNanoseconds })
    : pauseGeneric;

  return (
    value: number,
    spinMicroseconds: number,
    parkMs?: number,
  ) => {
    const until = performance.now() + (spinMicroseconds / 1000);

    do {
      if (
        opView[at] !== value || txStatus[0] === 1
      ) return;

      pause();
    } while (
      performance.now() < until
    );

    rxStatus[0] = 0


    Atomics.wait(
      opView,
      0,
      value,
      parkMs ?? 50,
    );

    rxStatus[0] = 1

  };
};
