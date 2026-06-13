export const NUMERIC_ARRAY_BRAND = Symbol.for("knitting.numericArray");

export class NumericArray extends Array<number> {}

Object.defineProperty(NumericArray.prototype, NUMERIC_ARRAY_BRAND, {
  value: true,
  enumerable: false,
  writable: false,
  configurable: false,
});

export const isNumericArray = (value: object): value is NumericArray =>
  (value as Record<symbol, unknown>)[NUMERIC_ARRAY_BRAND] === true;

export const numericArrayFromFloat64 = (view: Float64Array): NumericArray => {
  const length = view.length;
  const out = new NumericArray(length);
  for (let i = 0; i < length; i++) out[i] = view[i]!;
  return out;
};
