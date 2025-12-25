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
  const ends = new Uint32Array(Lock.slots);

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


   const storeAtomics = (index : number ) => Atomics.store(hostBits, 0 , hostLast[0] ^=  (1 << index))

  const AllocTask = (task: Task) => {


    
    if(updateTableCounter++ === 8 ) (updateTableCounter = 0 , updateTable())


      // Works with the static versions of table

    if(tableLength === 0) {
      task[TaskIndex.Start] =  startAndIndex[0] = 0
      task[TaskIndex.End] = ends[0] = (task[TaskIndex.PayloadLen] + 63 ) & ~63
      tableLength++

       return void storeAtomics(0)
    }

    
    if(tableLength === 1) {
      task[TaskIndex.Start] = startAndIndex[1] = ends[0]
      task[TaskIndex.End] = ends[1] = ( ends[0] + task[TaskIndex.PayloadLen] + 63 ) & ~63
      tableLength++

      return void storeAtomics(1)
    }


    {
     const size = task[TaskIndex.PayloadLen] | 0

      let index =  0;

      for (let at = 1  ; at != 32 ; at++){
    
      
           index = startAndIndex[at] & 63
        
          // this basically checks for the real space 
          if(
            
            startAndIndex[at + 1 ]  - 
            // real space 
            (ends[index] + startAndIndex[at]  )
              <
              size 
            
          ) continue


          // if this is the case shift elements to right from `at`
          for (let current = tableLength; at >= current ; current--){
            startAndIndex[current + 1] = startAndIndex[current]
          }

          return void storeAtomics(at)
     
      }
      
    }

  }


 


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
