/**
 * @file test/storage/relation-import-binding.test.ts
 * @description The bundle-relation leg of OKF import as ONE body over
 * `RelationImportSteps` (`applyBundleRelationsWith`), none of which takes a
 * project root, against the root form `applyBundleRelations`.
 *
 * HOW IT IS BUILT. Memory steps that log every call answer the live relations
 * and the lock-free append (a content-hash hit returns the existing id). They
 * pin the untrusted no-op, the known-id set read once before any append, each
 * entry's imported/deduplicated/skipped-invalid outcome, and the fail-closed
 * abort that reports every remaining entry once the store fails, whether at
 * the read or mid-loop. The root form is shown handing each incumbent the root
 * and the body's exact arguments.
 *
 * NOT SHOWN HERE: the relation store's validation and dedupe; the relation and
 * import suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { BundleRelationEntry } from "../../src/export/okf/bundle-block.js";
import { applyBundleRelations, applyBundleRelationsWith, type RelationImportSteps } from "../../src/import/relation-import.js";
import * as relationStore from "../../src/relations/store.js";
import * as relationRead from "../../src/relations/store-read.js";
import { RelationEndpointError } from "../../src/relations/types.js";

afterEach(() => { vi.restoreAllMocks(); });

const PROFILE = { schemaVersion: 1, profileId: "p", entities: {} } as never;
/** A bundle entry from `from` to `to`. */
const entry = (from: string, to = "ideas/b"): BundleRelationEntry => ({ id: "foreign", type: "related", from, to, contentHash: "foreign" });

/** What the memory steps answer: live ids, and per-`from` the id an append returns or the error it throws. */
interface RelationWorld { live?: string[]; readFault?: Error; appended?: Record<string, string | Error> }

/** Memory relation-import steps; each call logged. */
function stepsOf(log: string[], world: RelationWorld = {}): RelationImportSteps {
  return {
    readRelations: async () => { log.push("read"); if (world.readFault) throw world.readFault; return { relations: (world.live ?? []).map((id) => ({ id })) } as never; },
    append: async (_profile, input) => {
      log.push(`append ${input.from}`);
      const answer = world.appended?.[input.from] ?? `rel_${input.from}`;
      if (answer instanceof Error) throw answer;
      return { id: answer } as never;
    },
  };
}

/** Apply `entries` over memory: `outcome[: reason]` per entry, and the log. */
async function apply(entries: BundleRelationEntry[], world: RelationWorld = {}, trusted = true) {
  const log: string[] = [];
  const outcomes = await applyBundleRelationsWith(stepsOf(log, world), PROFILE, entries, trusted);
  return { log, kinds: outcomes.map(({ outcome, reason }) => (reason === undefined ? outcome : `${outcome}: ${reason}`)) };
}

describe("the relation import leg as a root-free body", () => {
  it("R1 untrusted writes nothing and reads nothing; trusted reads the live ids once, then appends in order", async () => {
    expect(await apply([entry("a")], {}, false)).toEqual({ kinds: ["skipped-untrusted"], log: [] });
    expect(await apply([entry("a"), entry("b")])).toEqual({ kinds: ["imported", "imported"], log: ["read", "append a", "append b"] });
  });

  it("R2 a hit on a live id, or on an id this import just wrote, is deduplicated; an endpoint refusal is skipped-invalid", async () => {
    const appended = { a: "rel_live", b: "rel_x", c: "rel_x", d: new RelationEndpointError("unknown entity type") };
    expect((await apply([entry("a"), entry("b"), entry("c"), entry("d")], { live: ["rel_live"], appended })).kinds)
      .toEqual(["deduplicated", "imported", "deduplicated", "skipped-invalid: unknown entity type"]);
  });

  it("R3 a store failure at the read aborts every entry; mid-loop it keeps what landed and aborts the rest", async () => {
    expect(await apply([entry("a"), entry("b")], { readFault: new Error("store corrupt") })).toEqual({
      kinds: ["skipped-store-error: relation store unavailable: store corrupt", "skipped-store-error: relation store unavailable: store corrupt"], log: ["read"],
    });
    const mid = await apply([entry("a"), entry("b"), entry("c")], { appended: { b: new Error("store full") } });
    expect(mid).toEqual({
      kinds: ["imported", "skipped-store-error: relation store unavailable: store full", "skipped-store-error: relation store unavailable: store full"],
      log: ["read", "append a", "append b"],
    });
  });
});

describe("the root form", () => {
  it("Z1 hands each incumbent the root and the body's exact arguments", async () => {
    const read = vi.spyOn(relationRead, "readRelations").mockResolvedValue({ relations: [] } as never);
    const append = vi.spyOn(relationStore, "appendRelationLocked").mockResolvedValue({ id: "rel_a" } as never);
    await applyBundleRelations("/project", PROFILE, [{ ...entry("experiments/a"), attributes: { weight: 1 } }], true);
    expect([read.mock.calls, append.mock.calls]).toEqual([[["/project"]], [["/project", PROFILE, { type: "related", from: "experiments/a", to: "ideas/b", attributes: { weight: 1 } }]]]);
  });
});
