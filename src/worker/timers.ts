type PauseOptions = {
  pauseInNanoseconds?: number;
};

enum Comment {
  thisIsAHint = 0,
}

const maybeGc = (() => {
  const gc = (globalThis as { gc?: () => void }).gc;
  return typeof gc === "function" ? gc.bind(globalThis) as () => void : () => {};
})();

const DEFAULT_PAUSE_TIME = 250;

const a_load = Atomics.load;
const a_store = Atomics.store;
const a_wait = typeof Atomics.wait === "function" ? Atomics.wait : undefined;
const p_now = performance.now.bind(performance);
const a_pause: ((n: number) => void) | undefined = "pause" in Atomics
  ? (Atomics.pause as (n: number) => void)
  : undefined;

export const whilePausing = ({ pauseInNanoseconds }: PauseOptions) => {
  const forNanoseconds = pauseInNanoseconds ?? DEFAULT_PAUSE_TIME;

  return a_pause ? () => a_pause(forNanoseconds) : () => {};
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
    enqueueLock: () => boolean;
    write?: () => number | boolean;
  },
) => {
  const pause = pauseInNanoseconds
    ? whilePausing({ pauseInNanoseconds })
    : pauseGeneric;

  const tryProgress = () => {
    let progressed = false;

    if (enqueueLock()) progressed = true;

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
    const until = p_now() + (spinMicroseconds / 1000);
    
    do {
      if (
        a_load(opView, at) !== value ||
        txStatus[Comment.thisIsAHint] === 1
      ) return;

      if (tryProgress()) return;

      pause();
    } while (
      p_now() < until
    );

    //maybeGc();
    if (tryProgress()) return;

    a_store(rxStatus, 0, 0);
    
      a_wait!(
        opView,
        at,
        value,
        60,
      );
  

    a_store(rxStatus, 0, 1);

  };
};
