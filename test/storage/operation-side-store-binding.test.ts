/**
 * @file test/storage/operation-side-store-binding.test.ts
 * @description The operation side stores as root-free bodies over memory leaves:
 * the catalog (`appendCatalogRecordWith`), the effect reservation
 * (`reserveRecordEffectWith`), the projection (`writeProjectionWith`) and
 * inventory authority (`verifyInventoryAuthoritiesFrom`). Stage materialization
 * is reached through the staging suites (`stage*.test.ts`) and the journey.
 *
 * WHAT IS MEMORY ONLY. Each leaf double stores bytes in a map and logs every
 * call; it proves the bodies' order, replay, refusal and revalidation rules, not
 * confinement, no-follow reads or durable replacement, which stay in the local
 * factories and are covered by the existing catalog, reservation, projection and
 * staging suites. The last case shows the bodies make no ambient physical call
 * while the shipped catalog root entry reaches `atomicWrite` with its exact flags.
 */

import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import type { CappedLeafReadBuffer } from "../../src/utils/confined-read.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import {
  appendCatalogRecordLocked, appendCatalogRecordWith, CatalogConcurrentChangeError, createCatalogRecord, type CatalogLeaves,
} from "../../src/operation-bundles/catalog-store.js";
import * as durableCandidate from "../../src/operation-bundles/durable-candidate.js";
import * as durableLeaf from "../../src/operation-bundles/durable-leaf.js";
import { reserveRecordEffectWith, type EffectReservationLeaves } from "../../src/operation-bundles/effect-reservation.js";
import { mutationId, type BundleId } from "../../src/operation-bundles/ids.js";
import { verifyInventoryAuthoritiesFrom, type InventoryAuthorityReads } from "../../src/operation-bundles/inventory-authority.js";
import type { OperationLeafObservation } from "../../src/operation-bundles/orphan-scan.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { writeProjectionWith, type ProjectionLeaves, type ProjectionTarget } from "../../src/operation-bundles/projection-store.js";
import { captureRecordIntent } from "../../src/operation-bundles/record-intent.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";
import { tempRootTracker } from "../temp-roots.js";

const BUNDLE = "bnd_01J8Z0000000000000000000AB" as BundleId;
const AT = "2026-07-19T00:00:00.000Z";
const DIGEST = `sha256:${"0".repeat(64)}` as OperationDigest;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const tracker = tempRootTracker();
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

const RECORD = createCatalogRecord({ logicalRecordId: "source-one", mutationId: mutationId(BUNDLE, 0), payload: { title: "Source one" }, createdAt: AT });

/** A memory catalog; `beforeRevalidate` may change it at the writer's last pre-rename seam. */
function memoryCatalog(log: string[], start?: Buffer, beforeRevalidate?: (store: Map<string, Buffer>) => void): CatalogLeaves & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>(start === undefined ? [] : [["ws", start]]);
  return {
    store,
    readCatalogLeaf: async (ws) => { log.push("read"); const body = store.get(ws); return body === undefined ? { kind: "absent" } : { kind: "ok", body }; },
    replaceCatalog: async (ws, body, revalidate) => { log.push("replace"); beforeRevalidate?.(store); await revalidate(); store.set(ws, body); },
  };
}

describe("the side-store bodies over memory leaves", () => {
  it("S1 appends a catalog record as a whole canonical file, replays it identically, and refuses a concurrent change before publication", async () => {
    const log: string[] = [];
    const catalog = memoryCatalog(log);
    expect(await appendCatalogRecordWith(catalog, "ws", RECORD)).toBe("created");
    const first = catalog.store.get("ws")!;
    expect([await appendCatalogRecordWith(catalog, "ws", RECORD), catalog.store.get("ws")!.equals(first), first.toString("utf8").endsWith("}\n")]).toEqual(["same", true, true]);
    expect(log).toEqual(["read", "replace", "read", "read", "replace", "read"]);
    const raced = memoryCatalog([], first, (store) => store.set("ws", Buffer.from("raced\n")));
    await expect(appendCatalogRecordWith(raced, "ws", RECORD)).rejects.toBeInstanceOf(CatalogConcurrentChangeError);
    expect(raced.store.get("ws")!.toString()).toBe("raced\n");
  });

  it("S2 reserves once, reuses an existing reservation without minting, and refuses an interrupted create or an unreadable leaf without writing", async () => {
    const intent = captureRecordIntent({ schema: "llmwiki-record-intent-v1", workspaceId: "demo", effectId: "story-1", profileDigest: DIGEST,
      target: { entityType: "stories", slug: "one" }, precondition: { kind: "absent" }, proposedBody: "# Story\n",
      origin: { provider: "llmflow", runId: "run", occurrenceId: "one", proposalDigest: DIGEST } });
    const leaves = (read: CappedLeafReadBuffer, partial: boolean, log: string[], created: Buffer[] = []): EffectReservationLeaves => ({
      readReservation: async () => { log.push("read"); return read; },
      assertNoPartialReservation: async () => { log.push("partial"); if (partial) throw new Error("effect-reservation-unavailable"); },
      createReservation: async (_key, bytes) => { log.push("create"); created.push(bytes); },
    });
    const fresh: string[] = [], created: Buffer[] = [];
    const reservation = await reserveRecordEffectWith(leaves({ kind: "absent" }, false, fresh, created), "preparer", intent);
    const reuse: string[] = [], interrupted: string[] = [], unreadable: string[] = [];
    expect(await reserveRecordEffectWith(leaves({ kind: "ok", body: created[0]! }, false, reuse), "preparer", intent)).toEqual(reservation);
    await expect(reserveRecordEffectWith(leaves({ kind: "absent" }, true, interrupted), "preparer", intent)).rejects.toThrow("effect-reservation-unavailable");
    await expect(reserveRecordEffectWith(leaves({ kind: "unavailable" }, false, unreadable), "preparer", intent)).rejects.toThrow("effect-reservation-unavailable");
    expect([fresh, reuse, interrupted, unreadable]).toEqual([["read", "partial", "create"], ["read"], ["read", "partial"], ["read"]]);
  });

  it("S3 publishes the projection marker before the output, revalidating at each writer's seam, then verifies", async () => {
    const bytes = Buffer.from("{\"x\":1}\n"), log: string[] = [], pair = new Map<string, Buffer>();
    const target: ProjectionTarget = { workspaceId: "research", recipeId: "recipe", recipeDigest: DIGEST, output: "out.json", outputDigest: `sha256:${sha(bytes)}` as OperationDigest, criticality: "required" };
    const read = (name: string): CappedLeafReadBuffer => { const body = pair.get(name); return body === undefined ? { kind: "absent" } : { kind: "ok", body }; };
    const leaves: ProjectionLeaves = {
      readPair: async () => { log.push("readPair"); return { outputRead: read("output"), markerRead: read("marker") }; },
      writeMarker: async (_t, body, revalidate) => { log.push("writeMarker"); await revalidate(); pair.set("marker", body); },
      writeOutput: async (_t, body, revalidate) => { log.push("writeOutput"); await revalidate(); pair.set("output", body); },
    };
    expect(await writeProjectionWith(leaves, target, bytes)).toBe("created");
    expect(log).toEqual(["readPair", "writeMarker", "readPair", "readPair", "writeOutput", "readPair", "readPair"]);
    const intruded = { ...leaves, writeOutput: async (_t: ProjectionTarget, body: Buffer, revalidate: () => Promise<void>) => { pair.set("marker", Buffer.from("{}")); await revalidate(); pair.set("output", body); } };
    pair.clear();
    await expect(writeProjectionWith(intruded, target, bytes)).rejects.toThrow("projection changed concurrently before output publication");
    expect(pair.has("output")).toBe(false);
  });

  it("S4 verifies authorities in store order with ONE key read, and records a payload whose bytes do not match its address", async () => {
    const log: string[] = [], good = Buffer.from("good"), leaf = (kind: OperationLeafObservation["kind"], name: string, extra: object): OperationLeafObservation =>
      ({ relativePath: name, logicalRelativePath: name, kind, bytes: 4, dev: 1, ino: 1, workspaceId: "research", ...extra });
    const reads: InventoryAuthorityReads = {
      readLeaf: async (location) => { log.push(location.kind); return { kind: "ok", body: location.kind === "payload" && location.digest === sha(good) ? good : Buffer.from("bad") }; },
      readKey: async () => { log.push("key"); return { status: "absent" }; },
    };
    const problems: { dimension: string }[] = [];
    await verifyInventoryAuthoritiesFrom(reads, [
      leaf("run", `research/runs/opr_01J8Z0000000000000000000CD.json`, { runId: "opr_01J8Z0000000000000000000CD" }),
      leaf("payload", `research/bundles/${BUNDLE}/payloads/${sha(good)}`, { bundleId: BUNDLE }),
      leaf("payload", `research/bundles/${BUNDLE}/payloads/${"f".repeat(64)}`, { bundleId: BUNDLE }),
    ], problems as never);
    expect(log).toEqual(["payload", "payload", "key", "run"]);
    expect(problems.map((item) => item.dimension)).toEqual(["payload-state", "run-state"]);
  });

  it("S5 makes no ambient physical call from the bound bodies, while the catalog root entry reaches atomicWrite with its exact flags", async () => {
    const replaced = vi.spyOn(atomicWriteModule, "atomicWrite");
    const spies = [replaced, vi.spyOn(atomicWriteModule, "atomicWriteNoReplaceDurable"),
      vi.spyOn(confinedRead, "readConfinedLeafBuffer"), vi.spyOn(durableLeaf, "readDurableOperationLeafBuffer"), vi.spyOn(durableCandidate, "inspectDurableCandidate")];
    await appendCatalogRecordWith(memoryCatalog([]), "ws", RECORD);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    const root = await tracker.create("operation-side-store-binding-");
    expect(await appendCatalogRecordLocked(root, "research", RECORD)).toBe("created");
    expect(replaced.mock.calls.map(([file, , options]) => [file, { ...options, afterParentCheckForTest: typeof options?.afterParentCheckForTest }])).toEqual([[
      operationPaths(root, "research").catalogFile,
      { confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600, afterParentCheckForTest: "function" },
    ]]);
  });
});
