import { SAB_ENABLED_BY_DEFAULT } from "../src/memory/sab-reclaim-mode.ts";

/**
 * Whether a pool built without explicit options will install a slab pool.
 *
 * `KNITTING_SAB_RECLAIM=off` turns the pointer path off process-wide, which is
 * exactly what someone reaches for when they suspect it of causing a bug. Tests
 * that assert the feature is *active* have to skip under it, or that diagnostic
 * reports failures that are really just the switch doing its job.
 */
export const sharedReturnsEnabled: boolean = typeof SharedArrayBuffer ===
    "function" && SAB_ENABLED_BY_DEFAULT;
