
 export const asmModule = (function (stdlib, foreign, heap) {
  "use asm";
  const clz = stdlib.Math.clz32;

  // count trailing zeros
  function ctrz(integer:number) {
    integer = integer | 0; 
    // Note: asm.js doesn't have compound assignment operators such as &=
    integer = integer & -integer
    return (31 - clz(integer)) | 0;
  }

  
  // count trailing ones
  function ctron(integer:number) {
    integer = integer | 0; 
    return ctrz(~integer) | 0;
  }


  // asm.js demands plain objects:
  return { ctrz: ctrz, ctron: ctron };
})(globalThis, null, null);