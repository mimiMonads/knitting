import type { MainList } from "../types.ts";
import type { ReaderInShared, WriterInShared } from "./io.ts";

enum Mask {
  void = -1,
  inUse = 1,
  empty = 0,
}

export const lock = ({
  read,
  write,
  startListMem,
  endListMem,
  lockSector,
}: {
  read: ReaderInShared;
  write: WriterInShared;
  startListMem?: SharedArrayBuffer;
  endListMem?: SharedArrayBuffer;
  lockSector?: SharedArrayBuffer;
}) => {
  // one byte per slot: 0 = empty, 1 = in use
  const lockSector8 = new Uint8Array(
    lockSector ?? new SharedArrayBuffer(8)
  );

  // logical positions for each slot
  const start32 = new Int32Array(
    startListMem ?? new SharedArrayBuffer(8 * 4)
  );
  const end32 = new Int32Array(
    endListMem ?? new SharedArrayBuffer(8 * 4)
  );

  // find a free slot and write the list there
  const encode = (list: MainList): boolean => {
    for (let at = 0; at < 8; at++) {
      if (lockSector8[at] === Mask.empty) {
        return parseAt(list, at);
      }
    }
    return false;
  };

  // decode all slots that are in use, return true if anything was decoded
  const decode = (): boolean => {
    let modified = false;

    for (let at = 0; at < 8; at++) {
      if (lockSector8[at] === Mask.inUse) {
        if (decodeAt(at)) {
          modified = true;
        }
      }
    }

    return modified;
  };

  // ensure the next write point is aligned to 8
  const findPoint = (): number => {
 
    const at = Math.max(...end32) + 1;
    // align to next multiple of 8
    return at + ((8 - (at % 8)) % 8);
  };

  const parseAt = (list: MainList, at: number): boolean => {
    const start = findPoint();
    const end = write(list, start);

    start32[at] = start;
    end32[at] = end;
    lockSector8[at] = Mask.inUse;

    return true;
  };

  const decodeAt = (at: number): boolean => {
    // if there is no valid data, do nothing
    if (start32[at] === Mask.void || end32[at] === Mask.void) {
      return false;
    }

    // this read adds it to a list / does the side effect
    read(at);

    // clear the slot
    start32[at] = Mask.void;
    end32[at] = Mask.void;
    lockSector8[at] = Mask.empty;

    return true;
  };

  return {
    encode,
    decode,
  };
};
