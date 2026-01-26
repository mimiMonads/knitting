type PauseOptions = {
  pauseInNanoseconds?: number;
};

const DEFAULT_PAUSE_TIME = 500;

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
    enqueueLock,
    write,
  }: {
    opView: Int32Array;
    rxStatus: Int32Array;
    txStatus: Int32Array;
    pauseInNanoseconds?: number;
    at: number;
    enqueueLock?: () => boolean;
    write?: () => number | boolean;
  },
) => {
  const pause = pauseInNanoseconds
    ? whilePausing({ pauseInNanoseconds })
    : pauseGeneric;

  const tryProgress = () => {
    let progressed = false;

    if (enqueueLock?.()) progressed = true;

    if (write) {
      const wrote = write();
      if (typeof wrote === "number") {
        if (wrote > 0) progressed = true;
      } else if (wrote === true) {
        progressed = true;
      }
    }

    return progressed;
  };

  return (
    value: number,
    spinMicroseconds: number,
    parkMs?: number,
  ) => {
    const until = performance.now() + (spinMicroseconds / 1000);

    do {
      if (
        Atomics.load(opView, at) !== value || Atomics.load(txStatus, 0) === 1
      ) return;

      if (tryProgress()) return;

      pause();
    } while (
      performance.now() < until
    );

    if (tryProgress()) return;

    Atomics.store(rxStatus, 0, 0)


    Atomics.wait(
      opView,
      at,
      value,
      parkMs ?? 50,
    );

    Atomics.store(rxStatus, 0, 1)

  };
};
