/** Incremental pipe framing. Complete frames borrow their input chunk; a
 * fragmented payload is allocated once and each fragment is copied once. */
export class CompiledResponseFrames {
  private readonly header: Uint8Array;
  private headerUsed = 0;
  private payload: Uint8Array | undefined;
  private payloadUsed = 0;
  private status = 0;

  constructor(
    private readonly json: boolean,
    private readonly maxPayloadBytes: number,
    private readonly onFrame: (status: number, payload: Uint8Array) => void,
  ) {
    this.header = new Uint8Array(json ? 8 : 16);
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.payload !== undefined) {
        const count = Math.min(
          chunk.byteLength - offset,
          this.payload.byteLength - this.payloadUsed,
        );
        this.payload.set(
          chunk.subarray(offset, offset + count),
          this.payloadUsed,
        );
        this.payloadUsed += count;
        offset += count;
        if (this.payloadUsed === this.payload.byteLength) {
          const payload = this.payload;
          this.payload = undefined;
          this.payloadUsed = 0;
          this.onFrame(this.status, payload);
        }
        continue;
      }

      let bytes: Uint8Array;
      if (
        this.headerUsed === 0 &&
        chunk.byteLength - offset >= this.header.byteLength
      ) {
        bytes = chunk.subarray(offset, offset + this.header.byteLength);
        offset += this.header.byteLength;
      } else {
        const count = Math.min(
          chunk.byteLength - offset,
          this.header.byteLength - this.headerUsed,
        );
        this.header.set(
          chunk.subarray(offset, offset + count),
          this.headerUsed,
        );
        offset += count;
        this.headerUsed += count;
        if (this.headerUsed < this.header.byteLength) return;
        bytes = this.header;
        this.headerUsed = 0;
      }

      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      this.status = header.getInt32(0, true);
      if (!this.json) {
        this.onFrame(this.status, bytes.subarray(8));
        continue;
      }
      const length = header.getUint32(4, true);
      if (length > this.maxPayloadBytes) {
        throw new RangeError("Compiled worker returned an oversized response");
      }
      if (length <= chunk.byteLength - offset) {
        this.onFrame(this.status, chunk.subarray(offset, offset + length));
        offset += length;
      } else {
        this.payload = new Uint8Array(length);
        // The next iteration fills the first fragment, or the next push fills
        // it when the chunk ended exactly at the header boundary.
      }
    }
  }
}
