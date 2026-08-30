/** Claimant side of `claim-cost.ts`: spin the real `decode()` and count. */
import { workerData } from "node:worker_threads";
import { lock2, type StealClaimDiscipline } from "../../src/memory/lock.ts";
import "../../src/memory/payloadCodec.ts";

const CTL_STATE = 0;
const CTL_READY = 1;
const CTL_STRIDE = 16;
const CTL_COUNTERS = CTL_STRIDE;

const { shared, ctlSab, consumers, consumerId, regionLanes, stealClaim } =
  workerData as {
    shared: Parameters<typeof lock2>[0];
    ctlSab: SharedArrayBuffer;
    consumers: number;
    consumerId: number;
    regionLanes: number;
    stealClaim?: StealClaimDiscipline;
  };

const ctl = new Int32Array(ctlSab);
const endpoint = lock2({
  ...shared,
  consumers,
  consumerId,
  regionLanes,
  stealClaim,
});
const resolved = endpoint.resolved;

let claims = 0;
let drained = 0;
let polls = 0;

Atomics.add(ctl, CTL_READY, 1);
while (Atomics.load(ctl, CTL_STATE) === 0) { /* wait for the start gun */ }

// Publish counters as the run proceeds. The host terminates the pool once the
// window closes, and a preempted thread that only stored at the end would be
// killed before its numbers ever landed.
const claimCell = CTL_COUNTERS + consumerId * CTL_STRIDE;
while (Atomics.load(ctl, CTL_STATE) === 1) {
  for (let i = 0; i < 32; i++) {
    polls++;
    if (!endpoint.decode()) continue;
    claims++;
    drained += resolved.size;
    resolved.clear();
  }
  Atomics.store(ctl, claimCell, claims);
  Atomics.store(ctl, claimCell + 1, drained);
  Atomics.store(ctl, claimCell + 2, polls);
}

Atomics.store(ctl, claimCell, claims);
Atomics.store(ctl, claimCell + 1, drained);
Atomics.store(ctl, claimCell + 2, polls);
