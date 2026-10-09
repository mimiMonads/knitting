export const STRING_REFERENCE_CODEC_ID = "knitting.stringReference";
export const isStringReferenceValue = (_value: unknown): boolean => false;
export class StringReference {
  constructor(_text: string) {
    throw new Error("StringReference requires Node, Deno or Bun");
  }
  toMetadata(): never {
    throw new Error("StringReference requires Node, Deno or Bun");
  }
}
