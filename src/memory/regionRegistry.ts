import { Lock, Task , TaskIndex } from "./lock.ts";



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
  const sizeByIndex = new Uint32Array(Lock.slots);

  startAndIndex.fill(0xFFFFFFFF)

    

  let updateTableCounter = 1,
      tableLength = 0

    const hostLast = new Uint32Array(1)

  const updateTable = () => {
  

    // Getting a fresh load from atomics and updating the workerBits
    // To after get wich bits are free
    let freeBits =  (hostLast[0] ^ ( workerBits[0] = Atomics.load(workerBits, 0))) >>> 0,
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

      getIndex  = startAndIndex[0] & 31

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


   const storeAtomics = (index : number ) => Atomics.store(hostBits, 0 , hostLast[0] ^=  (1 << index))

  const allocTask = (task: Task) => {


    
    if(updateTableCounter++ === 8 ) (updateTableCounter = 0 , updateTable())


      // Works with the static versions of table

    if(tableLength === 0) {
      task[TaskIndex.Start] =  startAndIndex[0] = 0
      sizeByIndex[0] = (task[TaskIndex.PayloadLen] + 63 ) & ~63
      tableLength++

       return void storeAtomics(0)
    }

    
    if(tableLength === 1) {
      task[TaskIndex.Start] = startAndIndex[1] = startAndIndex[0] + sizeByIndex[0]
      sizeByIndex[1] = ( task[TaskIndex.PayloadLen] + 63 ) & ~63
      tableLength++

      return void storeAtomics(1)
    }


    {
     const size = task[TaskIndex.PayloadLen] | 0

      let index =  0, prevIndex = 0;

      for (let at = 1  ; at + 1 < tableLength ; at++){
    
      
           index = startAndIndex[at] & 31
        
          // this basically checks for the real space 
          if(
            
            startAndIndex[at + 1 ]  - 
            // real space 
            (sizeByIndex[index] + startAndIndex[at]  )
              <
              size 
            
          ) continue

          prevIndex =  startAndIndex[at - 1] & 31


          // if this is the case shift elements to right from `at`
          for (let current = tableLength; current > at ; current--){
            startAndIndex[current] = startAndIndex[current - 1]
          }

          // tell here to start and update table after shift
          task[TaskIndex.Start] = startAndIndex[at] = sizeByIndex[prevIndex] + startAndIndex[at - 1] 
          // add boundery of the memory
          sizeByIndex[at] = ( task[TaskIndex.PayloadLen] + 63 ) & ~63
          tableLength++

          return void storeAtomics(at)
     
      }

      // no gap found, append at the end if there's capacity
      if (tableLength < Lock.slots) {
        const lastPos = tableLength - 1
        const lastIndex = startAndIndex[lastPos] & 31

        task[TaskIndex.Start] = startAndIndex[tableLength] =
          sizeByIndex[lastIndex] + startAndIndex[lastPos]
        sizeByIndex[tableLength] = ( task[TaskIndex.PayloadLen] + 63 ) & ~63
        tableLength++

        return void storeAtomics(lastPos + 1)
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
  };
};
