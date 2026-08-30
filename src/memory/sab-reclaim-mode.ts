import { getNodeProcess } from "../common/node-compat.ts";

// Experimental A/B switch for slab reclamation, read once at load.
//
//   KNITTING_SAB_RECLAIM=ring   (default) call-rate-paced; the returned view is
//                               borrowed and valid until the ring wraps
//   KNITTING_SAB_RECLAIM=gc     exact, GC-paced; a slab is never refilled while
//                               the host can still read it
//   KNITTING_SAB_RECLAIM=off    no slab returns at all; everything copies
//
// `unsafe.SharedBytesReclaim` overrides the mode and `unsafe.SharedBytes`
// overrides the off switch, so a pool can always opt back in explicitly.
//
// It lives in its own module so both the host and the worker resolve the same
// value without pulling the pool in.

const readEnv = (key: string): string | undefined => {
  const denoEnv = (globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno?.env;
  if (typeof denoEnv?.get === "function") {
    try {
      return denoEnv.get(key);
    } catch {
      /* env permission denied */
    }
  }
  try {
    return getNodeProcess()?.env?.[key];
  } catch {
    return undefined;
  }
};

const RECLAIM_ENV = readEnv("KNITTING_SAB_RECLAIM");

/**
 * Default when `unsafe.SharedBytesReclaim` is not set. `"ring"` because the
 * measured alternative starves: on node at one worker, `"gc"` makes a 1 MiB
 * slab return *slower* than copying (0.68x) while `"ring"` is 68.9x.
 */
export const SAB_RECLAIM_MODE: "gc" | "ring" = RECLAIM_ENV === "gc"
  ? "gc"
  : "ring";

/**
 * Whether slab returns are on unless a pool says otherwise. `KNITTING_SAB_RECLAIM=off`
 * turns the feature off process-wide, which is the cheapest way to tell whether
 * a bug involves the pointer path at all.
 */
export const SAB_ENABLED_BY_DEFAULT: boolean = RECLAIM_ENV !== "off";
