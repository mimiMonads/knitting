import { Lock } from "./lock.ts";



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


  const startAndIndex = new Uint32Array(Lock.slots);
  const ends = new Uint32Array(Lock.slots);

  startAndIndex.fill(0xFFFFFFFF)

    

  let updateTableCounter = 1,
      tableLength = 0

    const hostLast = new Uint32Array(1)

  const updateTable = () => {
  
    let freeBits =  (hostLast[0] ^ Atomics.load(workerBits, 0)) >>> 0,
      newLength = tableLength


    // nothing changed
    if (freeBits === 0) return;

    // make it 32 and not
     freeBits = ~freeBits >>> 0;


    // reset if empty 
    if (freeBits === 0xFFFFFFFF) {
      startAndIndex.fill(0xFFFFFFFF);
      // we dont need to update the end table 
      tableLength = 0;
      return;
    }


    for (let i = 0 , getIndex = 0; i < tableLength;) {

      getIndex  = startAndIndex[0] & 32

      if ((freeBits ^ 1 << getIndex) !== 0) {
        startAndIndex[getIndex] = 0xFFFFFFFF
        --newLength
        --tableLength

        // re-order to left
        for(let j = 0; i < tableLength; j++){
          startAndIndex[j] = startAndIndex[j+1]
        }

        continue;
      }
        i++
    }

    tableLength = newLength

  };

  // Ask for a pointer where a lenght is garanted to be empty
  // This doesnt atcually change any internal state

  const region = (length: number): number => {


    if(tableLength === 0) 64
    if(tableLength === 1) ends[0]

    length += 64







    return ends[tableLength]
  };

  const alloc = (index: number, start: number, end: number) => {

    // Kinda expensive so runs every x cycles
    if(updateTableCounter++ === 8 ) (updateTableCounter = 0 , updateTable())

 
    // this value can vener reach 0xFFFFFFFF, because the index goes up to 32
    // and we are shifting 64 

    startAndIndex[tableLength++] = start & ~63 | index;

    //The optimizar should `andl` in both cases instead of `sarl` and `shrl`
    ends[index] = ( end  + 63 ) >> 6 << 6
    //ends[index] = (end + 63) & ~63
    Atomics.store(hostBits, 0 , hostLast[0] ^=  (1 << index))


  };


  // Worker is the only one that frees , thus can not trigger ` upadeTable `
  const workerLast = new Uint32Array(1)
  const free = (index: number) => {

    Atomics.store(workerBits, 0 , workerLast[0] ^=  (1 << index))
   
  };

  
  return {
    lockSAB,
    alloc,
    free,
    hostBits,
    workerBits,
  };
};
