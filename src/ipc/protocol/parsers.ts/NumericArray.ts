const kBrand = Symbol("NumericArray");
type NumericArrayArgs = number[] | Float64Array;
export class NumericArray {
  private arr?: number[];
  private arrFloat?: Float64Array;
  private isFloat = false;
  private [kBrand] = true;

  constructor(data: NumericArrayArgs) {
    if (data instanceof Float64Array) {
      this.arrFloat = data;
      this.isFloat = true;
    } else {
      this.arr = data;
      this.isFloat = false;
    }
  }
  static FloatToArray(srcF64: Float64Array): number[] {
    const len = srcF64.length;
    const arr = new Array(len);
    const rem = len & 3;
    let i = 0;
    for (; i < len - rem; i += 4) {
      arr[i] = srcF64[i];
      arr[i + 1] = srcF64[i + 1];
      arr[i + 2] = srcF64[i + 2];
      arr[i + 3] = srcF64[i + 3];
    }
    for (; i < len; i++) arr[i] = srcF64[i];
    return arr;
  }
  static isNumericArray(v: any): v is NumericArray {
    return !!(v && v[kBrand]);
  }
  static fromFloat64(srcF64: Float64Array): NumericArray {
    const len = srcF64.length;
    const arr = new Array(len);
    const rem = len & 3;
    let i = 0;
    for (; i < len - rem; i += 4) {
      arr[i] = srcF64[i];
      arr[i + 1] = srcF64[i + 1];
      arr[i + 2] = srcF64[i + 2];
      arr[i + 3] = srcF64[i + 3];
    }
    for (; i < len; i++) arr[i] = srcF64[i];
    return new NumericArray(arr);
  }
  static fromArrayCopy(arr: number[]): NumericArray {
    return new NumericArray([...arr]);
  }
  toArray(): number[] {
    if (this.isFloat) {
      this.isFloat = true;
      return this.arr = NumericArray.FloatToArray(this.arrFloat!);
    }
    return this.arr!;
  }
  toFloat64(): Float64Array {
    if (this.isFloat) return this.arrFloat!;
    return Float64Array.from(this.arr!);
  }
}
