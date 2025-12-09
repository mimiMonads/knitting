import { Lock } from "./lock.ts";

enum Layout {
  start = 0,
  End = 1,
  Length = 2, 
}

export const register = ({
  lockSector,
}: {
  lockSector: SharedArrayBuffer;
}) => {
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(
      Lock.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    );

  const hostBits = new Int32Array(lockSAB, Lock.padding, 1);
  const workerBits = new Int32Array(lockSAB, Lock.padding * 2, 1);

  // local table: [start, end] per slot
  const sectors = new Uint32Array(Lock.slots * Layout.Length);


  const masksNot = new Uint32Array(Lock.slots);
  const mask = new Uint32Array(Lock.slots);

  for (let i = 0; i < Lock.slots; i++) {
    mask[i] = (1 << i) >>> 0;
    masksNot[i] = ~mask[i] >>> 0;
  }

  let usedBytes = 0,
      updateTableCounter = 1

  const updateTable = () => {
    // compute current free bits (force to unsigned 32-bit)
    usedBytes = (hostBits[0] ^ Atomics.load(workerBits, 0)) >>> 0
    const freeBits = ~usedBytes;

    // for every free bit, clear its sector entry
    for (let i = 0; i < Lock.slots; i++) {
      if ((freeBits & mask[i]) !== 0) {
        const offset = i * Layout.Length;
        sectors[offset + Layout.start] = 0;
        sectors[offset + Layout.End] = 0;
      }
    }
  };

  const region = (length: number): number => {
    // always read fresh bits; don't trust usedBytes cache here



    // no suitable region found
    return -1;
  };

  const alloc = (index: number, start: number, end: number) => {

    // Kinda expensive so runs every x cycles
    if(++updateTableCounter === 8 ) (updateTableCounter = 0 , updateTable())

    const offset = index * Layout.Length;
    sectors[offset + Layout.start] = start >>> 0;
    sectors[offset + Layout.End] = end >>> 0;

  };


  // Worker is the only one that frees , thus can not trogger ` upadetable `
  const free = (index: number) => {
    Atomics.xor(workerBits, 0, mask[index]);
  };

  
  return {
    lockSAB,
    alloc,
    free,
    sectors,
    hostBits,
    workerBits,
  };
};
