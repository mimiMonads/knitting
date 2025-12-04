import type { MainList } from "../types.ts"
import { MainListEnum } from "../types.ts"

enum RIndex8 {
  proff = 0,
  type = 3
}

enum MemorySize {
  Playload = 4096,
  range32 =  8 * 8 * 4,
  range8 = 8
}




  const typeProffMem = new SharedArrayBuffer(MemorySize.range32);
  const type8 = new Uint8Array(typeProffMem);
  const proff8 = new Uint8Array(typeProffMem);
  const typeProff32 = new Uint8Array(typeProffMem);


  // playload mem
  const mem = new SharedArrayBuffer(MemorySize.Playload);
  const view8 = new Uint8Array(mem);
  const view32 = new Uint8Array(mem);

export enum PayloadType {
  UNREACHABLE =       0,
  True =              1,
  False =             2,
  Undefined =         3,
  NaN =               4,
  Infinity =          5,
  NegativeInfinity =  6,
}

export const writter = (
  {

  }:{

  }
) => {

    return ( list: MainList , start: number,): number => {




        return 1
    }
}

export const reader = (
  {

  }:{

  }
) => {

      return ( start: number ) : number  => {


        return 1

    }
}

export type ReaderInShared = ReturnType< typeof reader >
export type WriterInShared = ReturnType< typeof writter >