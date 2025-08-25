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
    txStatus
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
    msTime: number,
    timeforWakingUp?: number 
  ) => {
    const until = performance.now() + (msTime / 1000);

    do {
      if (Atomics.load(opView, at) !== value || Atomics.load(txStatus, 0) === 1) return;

      pause();
    } while (
      performance.now() < until
    );

    Atomics.store(rxStatus, 0, 1);

    Atomics.wait(
      opView,
      0,
      value,
      timeforWakingUp ?? 50,
    );
    Atomics.store(rxStatus, 0, 0);

  };
};
