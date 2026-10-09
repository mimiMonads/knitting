import assert from "node:assert/strict";
import test from "./_runner.ts";
import { isStringReferenceMetadata, StringReference } from "../experimental.ts";
import { createPool } from "../knitting.ts";
import {
  echoStringReference,
  failStringReference,
} from "./fixtures/string_reference_tasks.ts";

const supported = (() => {
  try {
    const ref = new StringReference("");
    ref.release();
    return true;
  } catch {
    return false;
  }
})();
const options = {
  skip: supported ? false : "StringReference native addon not built",
};
test(
  "StringReference clones own immutable storage and strings survive release",
  options,
  () => {
    for (const text of [
      "", "ASCII\0\x7f".repeat(16384), "\0\ud800x\udfff", "é編🧶".repeat(16384),
      // Non-ASCII outside the native prefix probe must fall back losslessly.
      ...["é", "編", "🧶", "\ud800", "\udfff"].map((suffix) => "a".repeat(1024) + suffix),
      "a".repeat(63) + "編", "a".repeat(64) + "🧶",
    ]) {
      const ref = new StringReference(text);
      const clone = ref.clone();
      const decoded = StringReference.fromMetadata(
        JSON.parse(JSON.stringify(ref.toMetadata())),
      );
      const materialized = ref.toString();
      const byteLength = text.length * (/[^\x00-\x7f]/.test(text) ? 2 : 1);
      assert.equal(ref.byteLength, byteLength);
      assert.equal(clone.byteLength, byteLength);
      assert.equal(decoded.byteLength, byteLength);
      ref.release();
      ref.release();
      assert.equal(materialized, text);
      assert.equal(clone.toString(), text);
      assert.equal(decoded.toString(), text);
      assert.throws(() => ref.clone(), /released/);
      clone.release();
      decoded.release();
    }
  },
);
test(
  "StringReference validates process identity, native handles and character length",
  options,
  () => {
    assert.throws(
      () => new StringReference(123 as unknown as string),
      /expects a string/,
    );
    const ref = new StringReference("metadata");
    const metadata = ref.toMetadata();
    try {
      assert.ok(isStringReferenceMetadata(metadata));
      assert.equal(
        isStringReferenceMetadata({
          ...metadata,
          token: "18446744073709551616",
        }),
        false,
      );
      assert.throws(
        () => StringReference.fromMetadata({ ...metadata, origin: "node:0" }),
        /boundary/,
      );
      assert.throws(
        () => StringReference.fromMetadata({ ...metadata, length: 1 }),
        /length/,
      );
      assert.throws(() =>
        StringReference.fromMetadata({
          ...metadata,
          token: "18446744073709551615",
        }), /unknown/);
    } finally {
      ref.release();
    }
    assert.throws(() => StringReference.fromMetadata(metadata), /unknown/);
  },
);
test(
  "StringReference transport holds defer release until the last hold finishes",
  options,
  () => {
    const ref = new StringReference("held");
    const metadata = ref.toMetadata();
    const factory = (ref as unknown as Record<symbol, () => () => void>)[
      Symbol.for("knitting.payloadCodec.transportFinalizer")
    ];
    const finish = factory.call(ref);
    ref.release();
    const receiver = StringReference.fromMetadata(metadata);
    finish();
    finish();
    assert.throws(() => StringReference.fromMetadata(metadata), /unknown/);
    assert.equal(receiver.toString(), "held");
    receiver.release();
  },
);
test(
  "StringReference round trips survive concurrent calls, errors and worker shutdown",
  { ...options, timeout: 30000 },
  async () => {
    const globals = globalThis as typeof globalThis & {
      Bun?: unknown;
      Deno?: unknown;
    };
    const pool = createPool({
      threads: 1,
      permission: {
        node: { allowAddons: true },
        ...(globals.Bun || globals.Deno ? { ffi: true } : {}),
      },
    })({ echoStringReference, failStringReference });
    let survivor: StringReference | undefined;
    try {
      await Promise.all(Array.from({ length: 24 }, async (_, i) => {
        const text = `${i}\0é編🧶\ud800`.repeat(8192);
        const source = new StringReference(text);
        try {
          const returned = await pool.call.echoStringReference(source);
          try {
            assert.equal(returned.toString(), text);
          } finally {
            returned.release();
          }
        } finally {
          source.release();
        }
      }));
      const source = new StringReference("survives teardown\0🧶\udfff");
      try {
        survivor = await pool.call.echoStringReference(source);
      } finally {
        source.release();
      }
      const failure = new StringReference("error");
      try {
        await assert.rejects(
          pool.call.failStringReference(failure),
          /expected reference failure/,
        );
      } finally {
        failure.release();
      }
    } finally {
      await pool.shutdown();
    }
    try {
      assert.equal(survivor!.toString(), "survives teardown\0🧶\udfff");
    } finally {
      survivor?.release();
    }
  },
);
