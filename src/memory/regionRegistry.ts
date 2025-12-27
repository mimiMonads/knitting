import { Lock, Task , TaskIndex } from "./lock.ts";


/**
 * 
 * Complexity: Harry you are a wizard / 10 
 * 
 * SAFETY:
 *  - Single worker ownership; hostBits/workerBits are the only source of truth.
 *  - Caller/lock guarantees no overflow (<= 32 slots); no bounds checks here.
 *  - `free` is worker-only; reclaim happens only after worker signals and
 *    `updateTable` runs.
 *  - `updateTable` must be called periodically (every 8 allocs by default).
 *  - This is logical bookkeeping only; it does not check GSAB boundaries.
 *  - Only non-signal payloads should use this (objects requiring a buffer
 *    region); signals like booleans are excluded.
 *  - `updateTable` compacts `startAndIndex` only; `size64bit` is rewritten
 *    on allocation and is not compacted by design.
 */

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
  const size64bit = new Uint32Array(Lock.slots);

  const clz32 = Math.clz32
  
  
  const EMPTY = 0xFFFFFFFF;
  startAndIndex.fill(EMPTY)

    

  let updateTableCounter = 1,
      tableLength = 0

    const hostLast = new Uint32Array(1)

  const startAndIndexToArray = (length: number) => [...startAndIndex].slice(0,length)



  const compactSectorStable = ( b:number)  => {

  let w = 0 | 0  , r = 0 | 0;

    b = b | 0 

  for (; r + 3 < b; r += 4) {
    let v0 = startAndIndex[r];
    let v1 = startAndIndex[r + 1];
    let v2 = startAndIndex[r + 2];
    let v3 = startAndIndex[r + 3];

    if (v0 !== EMPTY) startAndIndex[w++] = v0;
    if (v1 !== EMPTY) startAndIndex[w++] = v1;
    if (v2 !== EMPTY) startAndIndex[w++] = v2;
    if (v3 !== EMPTY) startAndIndex[w++] = v3;
  }

  for (; r < b; r++) {
    const v = startAndIndex[r];
    if (v !== EMPTY) startAndIndex[w++] = v;
  }

  // In theory we dont have to clean values after w
  // while (w < b) startAndIndex[w++] = EMPTY;

  
}
  const updateTable = () => {
  

    // Getting a fresh load from atomics and updating the workerBits
    // To after get wich bits are free
    const state = (hostLast[0] ^ (workerBits[0] = Atomics.load(workerBits, 0))) >>> 0
    let freeBits = ~state >>> 0
    let newLength = tableLength

    // nothing to clear
    if (freeBits === 0 || tableLength === 0) return;


    // reset if empty 
    if (freeBits === EMPTY) {
      startAndIndex.fill(EMPTY);
      // we dont need to update the end table 
      tableLength = 0;
      return;
    }


  
    let idx  = 0 ;
       // Clear freed entries using trailing-zero scan
    while (freeBits !== 0) {
      idx = 31 - clz32(freeBits);
      if (idx < tableLength && startAndIndex[idx] !== EMPTY) {
        startAndIndex[idx] = EMPTY;
        newLength--;
      }
      freeBits ^= (1 << idx);
    }


    compactSectorStable( tableLength )
    tableLength = newLength

  };


   const storeAtomics = (index : number ) => Atomics.store(hostBits, 0 , hostLast[0] ^=  (1 << index))

  const allocTask = (task: Task) => {
    
    if(updateTableCounter++ === 8 ) (updateTableCounter = 0 , updateTable())

      // Works with the static versions of table

      // ensure a padding of 64 and ending on 63
      // so the task always starts in multiples of 64
    const payloadAlignedBytes64 = ((task[TaskIndex.PayloadLen] + 65 ) & ~63) 

    if(tableLength === 0) {
      // (load <<< 6) + 0
      startAndIndex[0] = 0
      size64bit[0] = payloadAlignedBytes64
      task[TaskIndex.Start] = 0
      tableLength++

       return  storeAtomics(0)
    }

    
    if(tableLength === 1) {
 
      size64bit[1] = payloadAlignedBytes64
      // load +  + index
       startAndIndex[1]  = (
        task[TaskIndex.Start] = size64bit[0] 
       ) + 1
      
     

      tableLength++

      return  storeAtomics(1)
    }



    // broken has to be fixed
    {
     const size = payloadAlignedBytes64 | 0

      for (let at = 0  ; at + 1 < tableLength ; at++){
    
      
          // this basically checks for the real space 
          if(
            
            startAndIndex[at + 1 ]  - 
            // real space 
            ((size64bit[at] * 64 ) + startAndIndex[at]  )
              <
              size 
            
          ) continue


          // if this is the case shift elements to right from `at`
          for (let current = tableLength; current > at + 1 ; current--){
            startAndIndex[current] = startAndIndex[current - 1]
            size64bit[current] = size64bit[current - 1]
          }

          // tell here to start and update table after shift
           startAndIndex[at + 1] = (size64bit[at] +( startAndIndex[at] & ~31) + (31 -  clz32(workerBits[0]))  )
           task[TaskIndex.Start] =
          // add boundery of the memory
          size64bit[at + 1] = size
          tableLength++

          return  storeAtomics(at + 1)
     
      }



          // no gap found, append at the end if there's capacity
      if (tableLength < Lock.slots) {
       
        const last = startAndIndex[tableLength - 1]
      

        task[TaskIndex.Start] = (startAndIndex[tableLength] =
        size64bit[last & 31 ] + last + 1) & ~31 

        size64bit[tableLength] = payloadAlignedBytes64
    

        return  storeAtomics(tableLength++)
      }
      
    }

  }



  // Worker is the only one that frees , thus can not trigger ` upadeTable `
  const workerLast = new Uint32Array(1)
  const free = (index: number) => {

    Atomics.store(workerBits, 0 , workerLast[0] ^=  (1 << index))
   
  };

  
  
  return {
    allocTask,
    lockSAB,
    free,
    hostBits,
    workerBits,
    updateTable,
    startAndIndexToArray
  };
};
