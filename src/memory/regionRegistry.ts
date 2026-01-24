import { LockBound,  TaskIndex } from "./lock.ts";
import type { Task  } from "./lock.ts";

/**
 * 
 * Complexity: Harry you are a wizard (9) / 10 
 * 
 * SAFETY:
 *  - Single worker ownership; `hostBits`/`workerBits` are the only source of truth.
 *  - `tableLength` is the only source of truth for valid entries; 
 *    stale values beyond it are ignored.
 *  - Caller/lock guarantees no overflow (<= 32 slots); no bounds checks here.
 *  - low 5 bits of `startAndIndex` are the slot index; 
 *    size64bit is indexed by slot index, never table index.
 *  - `free` is worker-only; reclaim happens only after worker signals and
 *    `updateTable` runs.
 *  - `updateTable` must be called periodically (every 8 allocs by default).
 *  - This is logical bookkeeping only; it does not check GSAB boundaries.
 *  - Only non-signal payloads should use this (objects requiring a buffer
 *    region); signals like booleans are excluded.
 *  - `updateTable` compacts `startAndIndex` only; `size64bit` is rewritten
 *    on allocation and is not compacted by design.
 *  - `usedBits` only `shrinks` in `updateTable`; `free`() alone never allows reuse.
 */

export type RegisterMalloc = ReturnType<typeof register>

export const register = ({
  lockSector,
}: {
  lockSector?: SharedArrayBuffer;
}) => {
  const lockSAB =
    lockSector ??
    new SharedArrayBuffer(
      LockBound.padding * 3 + Int32Array.BYTES_PER_ELEMENT * 2,
    );

  const hostBits = new Int32Array(lockSAB, LockBound.padding, 1);
  const workerBits = new Int32Array(lockSAB, LockBound.padding * 2, 1);


  const startAndIndex = new Uint32Array(LockBound.slots);
  const size64bit = new Uint32Array(LockBound.slots);

  const clz32 = Math.clz32
  
  
  const EMPTY = 0xFFFFFFFF;
  startAndIndex.fill(EMPTY)

    

  let updateTableCounter = 1,
      tableLength = 0
  let usedBits = 0

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

  return w
}
  const updateTable = () => {
  

    // Getting a fresh load from atomics and updating the workerBits
    // To after get wich bits are free
    const state = (hostLast[0] ^ Atomics.load(workerBits, 0)) >>> 0
    let freeBits = ~state >>> 0

    // nothing to clear
    if (freeBits === 0 || tableLength === 0) return;


    // reset if empty 
    if (freeBits === EMPTY) {
      startAndIndex.fill(EMPTY);
      // we dont need to update the end table 
      tableLength = 0;
      usedBits = 0
      return;
    }


  
    // clearing
    for ( let i = 0 ; i < tableLength; i++){
      const slot = startAndIndex[i] & 31
      if (( freeBits & (1 << slot) ) !== 0){
          startAndIndex[i] = EMPTY;
          usedBits &= ~(1 << slot)
      }
    }


    tableLength = compactSectorStable( tableLength )

  };


   const storeAtomics = (bit : number ) => Atomics.store(hostBits, 0 , hostLast[0] ^=  bit)
   const loadFreeBit = () => {
     const freeBits = (~usedBits) >>> 0
     if (freeBits === 0) return 0
     return (freeBits & -freeBits) >>> 0
   }

  const allocTask = (task: Task) => {
    
    if(updateTableCounter++ === 8 ) (updateTableCounter = 0 , updateTable())

      // Works with the static versions of table

      // ensure a padding of 64 and ending on 63
      // so the task always starts in multiples of 64
    const payloadAlignedBytes64 = ((task[TaskIndex.PayloadLen] + 64 ) & ~63) 
    const freeBit = loadFreeBit()
    if (freeBit === 0) return - 1
    const slotIndex = 31 - clz32(freeBit)
    if (tableLength >= LockBound.slots) return -1
    const storeSlot = (bit: number) => (
      task[TaskIndex.slotBuffer] = slotIndex,
      storeAtomics(bit)
    );

    {
     const size = payloadAlignedBytes64 | 0
     const hasEntries = tableLength > 0
     const firstStart = hasEntries ? (startAndIndex[0] & ~31) : 0
     const startAtBeginning = !hasEntries || firstStart >= size

     if (startAtBeginning) {
      for (let current = tableLength; current > 0 ; current--){
        startAndIndex[current] = startAndIndex[current - 1]
      }

      startAndIndex[0] = slotIndex
      size64bit[slotIndex] = size
      task[TaskIndex.Start] = 0
      tableLength++

      usedBits |= freeBit
      return  storeSlot(freeBit)
     }

      for (let at = 0  ; at + 1 < tableLength ; at++){
    
      
          // this basically checks for the real space 
          if(
            
            (startAndIndex[at + 1 ]  & ~31)- 
            (
              // real space 
              size64bit[startAndIndex[at] & 31] + 
              (startAndIndex[at] & ~31) 
            )
              <
              size 
            
          ) continue


          // if this is the case shift elements to right from `at`
          for (let current = tableLength; current > at + 1 ; current--){
            startAndIndex[current] = startAndIndex[current - 1]
          }

          const newStart = ( startAndIndex[at] & ~31 ) +
            size64bit[startAndIndex[at] & 31]

          // tell here to start and update table after shift
           startAndIndex[at + 1] = newStart | slotIndex
           
           task[TaskIndex.Start] = newStart

          size64bit[slotIndex] = size
          
          tableLength++

  
          usedBits |= freeBit
          return storeSlot(freeBit)
     
      }



          // no gap found, append at the end if there's capacity
      if (tableLength < LockBound.slots) {
       
        const last = startAndIndex[tableLength - 1];
         
        

        const newStart = (last & ~31) + (size64bit[last & 31 ])

        task[TaskIndex.Start] = newStart
        
        startAndIndex[tableLength] = newStart | slotIndex

       
        size64bit[slotIndex] = payloadAlignedBytes64
    

        tableLength++
        usedBits |= freeBit
        return storeSlot(freeBit)
      }

      return -1
      
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
