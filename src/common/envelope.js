export class Envelope {
    header;
    payload;
    constructor(header, payload) {
        this.header = header;
        this.payload = payload;
    }
}
