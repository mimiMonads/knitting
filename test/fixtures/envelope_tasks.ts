import { Envelope, task } from "../../knitting.ts";

export const echoEnvelope = task<Envelope, Envelope>({
  f: async (envelope) => envelope,
});
