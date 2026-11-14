/**
 * @file test/storage/preparation-inventory-binding.test.ts
 * @description The preparation inventory scan's REAL body,
 * `scanPreparationInventoryFrom`, run over an in-memory double of the five
 * reads it asks for. What is pinned is the scan's own classification and order:
 * which problem each failed read becomes and with what exact detail, the order
 * of the whole problem list (the active store's problems first, the lifecycle
 * problems LAST), which reads are made and in what sequence, that a manifest
 * failing the leaf pre-check costs no key or run read, how orphans, totals and
 * health are projected, and that a read's rejection is not caught.
 *
 * THE DOUBLE DECIDES NOTHING. Every read logs its arguments and returns the
 * answer the case scripted. It has no project root and touches no file.
 *
 * THE LAST BLOCK runs the borrowing body, `scanPreparationInventoryBorrowingFrom`,
 * over the same double plus a borrow that lends whatever read the case hands
 * it. It pins that body's own decisions: one borrow, at the limit taken from
 * the caller's options, with the scan inside it. THE BORROW DOUBLE VOUCHES FOR
 * ITS READ: it captures nothing, holds no lease and proves no provenance.
 *
 * WHAT THIS IS NOT. It is NOT evidence about the lifecycle PROOF, the read
 * LEASE or a read's PROVENANCE: the double's `assertLifecycleRead` resolves for
 * any object, where the local-disk reads reject a forged, expired or cross-root
 * read. It is NOT evidence of authentication, confinement or digest
 * verification either: on disk the run read authenticates the leaf against the
 * key, the key read refuses an unhealthy key file, and the manifest read
 * validates the leaf; the double does none of that. It shows NOTHING about leaf
 * classification or directory policy, because the double hands over leaves
 * already classified. Nothing here runs the local-disk reads, which are private
 * to the scan: that the disk key read hands on the epoch and never the key bytes
 * is read from the source, not tested.
 *
 * The double is not a hosted store and selects no backend.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  scanPreparationInventoryBorrowingFrom, scanPreparationInventoryFrom, type PreparationInventoryLifecycleReads, type PreparationInventoryReads,
} from "../../src/preparations/capacity.js";
import type {
  PreparationLifecycleReadV1, PreparationLifecycleStorageEntryV1,
} from "../../src/preparations/lifecycle-snapshot/types.js";
import { preparationManifestDigest, type PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import type { PreparationManifestRead } from "../../src/preparations/manifest-store.js";
import {
  preparationScanEntryLimit, type PreparationInventoryProblem, type PreparationLeafObservation, type PreparationScanOptions,
} from "../../src/preparations/orphan-scan.js";
import type { PreparationRunRead } from "../../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import { kindsOf } from "./call-log.js";
import { EPOCH, keyAndRunDoubles, type KeyAndRunScript } from "./preparation-key-run-doubles.js";

type KeyAnswer = Awaited<ReturnType<PreparationInventoryReads["readKeyEpoch"]>>;

const EVIDENCE_HEX = "c".repeat(64);
const LEAF_BYTES = 10;
const BOOM = new Error("the read rejected");
const UNAVAILABLE_READ: PreparationLifecycleReadV1 = { status: "unavailable", detail: "CAPTURE-DETAIL" };
const NON_OK_KEYS: readonly KeyAnswer[] = [{ status: "absent" }, { status: "unavailable" }];
const NON_OK_MANIFESTS: readonly PreparationManifestRead[] = [
  { status: "absent" }, { status: "invalid", detail: "STORE-DETAIL" }, { status: "unavailable", detail: "STORE-DETAIL" },
];
const NON_OK_RUNS: readonly PreparationRunRead[] = [
  { status: "absent" }, { status: "unavailable", detail: "STORE-DETAIL", code: "run-integrity-invalid" },
];

/** What one case scripts; every field has a plain ok default. The key and run fields are the shared fixture's. */
interface Script extends KeyAndRunScript {
  leaves?: readonly PreparationLeafObservation[];
  scanProblems?: readonly PreparationInventoryProblem[];
  traversalEntries?: number;
  manifests?: readonly PreparationManifestV1[];
  manifestRead?: PreparationManifestRead;
  /** Runs inside the lifecycle proof, before it resolves. */
  duringProof?: () => void;
}

/** One preparation's manifest double and its three classified leaves. */
interface Prepared {
  manifest: PreparationManifestV1;
  manifestLeaf: PreparationLeafObservation;
  evidenceLeaf: PreparationLeafObservation;
  runLeaf: PreparationLeafObservation;
}

let nextInode = 0;

/** One classified leaf with its own inode, so its bytes count once. */
function leafOf(
  kind: PreparationLeafObservation["kind"], relativePath: string, ids: Partial<PreparationLeafObservation> = {},
): PreparationLeafObservation {
  nextInode += 1;
  return { relativePath, logicalRelativePath: relativePath, kind, bytes: LEAF_BYTES, dev: 1, ino: nextInode, ...ids };
}

/** A manifest carrying only the fields the scan, the validator and the digest read. */
function preparedOf(name: string, supersedes?: string): Prepared {
  const preparationId = `prp_${name}`;
  const runId = `prr_${name}`;
  const base = `workspaces/ws-one/preparations/${preparationId}`;
  const manifest = {
    preparationId, runId, workspaceId: "ws-one", createdAt: "2026-01-01T00:00:00.000Z",
    initialEvidence: [{ digest: `sha256:${EVIDENCE_HEX}` }],
    ...(supersedes === undefined ? {} : { supersedesPreparationId: `prp_${supersedes}` }),
  } as unknown as PreparationManifestV1;
  return {
    manifest,
    manifestLeaf: leafOf("manifest", `${base}/manifest.json`, { workspaceId: "ws-one", preparationId }),
    evidenceLeaf: leafOf("evidence", `${base}/evidence/${EVIDENCE_HEX}`, { workspaceId: "ws-one", preparationId }),
    runLeaf: leafOf("run", `workspaces/ws-one/runs/${runId}.json`, { workspaceId: "ws-one", runId }),
  };
}

/** All three leaves of each prepared record, in record order. */
function leavesOf(...records: readonly Prepared[]): PreparationLeafObservation[] {
  return records.flatMap((record) => [record.manifestLeaf, record.evidenceLeaf, record.runLeaf]);
}

/** The binding the scan must build for `manifest` as it is NOW. */
function bindingOf(manifest: PreparationManifestV1): PreparationRunBinding {
  return {
    runId: manifest.runId, preparationId: manifest.preparationId, workspaceId: manifest.workspaceId,
    manifestDigest: preparationManifestDigest(manifest), keyEpochId: EPOCH,
  };
}

/** A run double in one state. */
function runIn(state: PreparationRunV1["state"]): PreparationRunV1 {
  return { state } as unknown as PreparationRunV1;
}

/** A successful lifecycle read carrying only the storage the scan reads. */
function lifecycleOf(
  quarantine: Partial<PreparationLifecycleStorageEntryV1> = {}, prune: Partial<PreparationLifecycleStorageEntryV1> = {},
): PreparationLifecycleReadV1 {
  const empty: PreparationLifecycleStorageEntryV1 = { count: 0, bytes: 0, health: "ok", traversalEntries: 0 };
  return {
    status: "ok", snapshot: { storage: { quarantine: { ...empty, ...quarantine }, prune: { ...empty, ...prune } } },
  } as unknown as PreparationLifecycleReadV1;
}

/** The five reads over `script`, and the log of every call in order. */
function storeOf(script: Script = {}): { reads: PreparationInventoryReads; log: unknown[][] } {
  const log: unknown[][] = [];
  const reads: PreparationInventoryReads = {
    assertLifecycleRead: async (read) => {
      log.push(["proof", read]);
      script.duringProof?.();
    },
    scanActiveStore: async (options) => {
      log.push(["active", options]);
      return {
        leaves: script.leaves ?? [], workspaces: [], preparationDirectories: [],
        problems: script.scanProblems ?? [], traversalEntries: script.traversalEntries ?? 0,
      };
    },
    readManifest: async (workspaceId, preparationId) => {
      log.push(["manifest", workspaceId, preparationId]);
      const manifest = (script.manifests ?? []).find((candidate) => candidate.preparationId === preparationId);
      return script.manifestRead ?? (manifest === undefined ? { status: "absent" } : { status: "ok", manifest });
    },
    ...keyAndRunDoubles(log, script, runIn("running")),
  };
  return { reads, log };
}

/** A store holding these complete records, with every read answering ok. */
function completeStore(records: readonly Prepared[], script: Script = {}): Script {
  return { leaves: leavesOf(...records), manifests: records.map((record) => record.manifest), ...script };
}

describe("inventory scan over its own reads: the lifecycle read", () => {
  it("N1 an unavailable read is not asserted, becomes one fixed problem, and the active scan still runs", async () => {
    const store = storeOf();
    const inventory = await scanPreparationInventoryFrom(store.reads, UNAVAILABLE_READ);
    expect(kindsOf(store.log)).toEqual(["active"]);
    expect(inventory.problems).toEqual([
      { dimension: "lifecycle-storage", detail: "preparation lifecycle capture is unavailable" },
    ]);
    expect(inventory.quarantine).toEqual({ count: 0, bytes: 0, health: "unavailable" });
    expect(inventory.epoch.manifests.health).toBe("unavailable");
  });

  it("N2 a successful read is handed to the proof first, as the same object, before the active scan", async () => {
    const read = lifecycleOf({ count: 2, bytes: 7 });
    const store = storeOf();
    const inventory = await scanPreparationInventoryFrom(store.reads, read);
    expect(kindsOf(store.log)).toEqual(["proof", "active"]);
    expect(store.log[0]?.[1]).toBe(read);
    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine).toEqual({ count: 2, bytes: 7, health: "ok" });
  });

  it("N3 a rejecting proof rejects with the same object, and nothing else is read", async () => {
    const store = storeOf();
    const reads: PreparationInventoryReads = { ...store.reads, assertLifecycleRead: () => Promise.reject(BOOM) };
    await expect(scanPreparationInventoryFrom(reads, lifecycleOf())).rejects.toBe(BOOM);
    expect(store.log).toEqual([]);
  });

  it("N4 unavailable quarantine storage is a problem; unavailable prune storage is not", async () => {
    const quarantined = await scanPreparationInventoryFrom(
      storeOf().reads, lifecycleOf({ count: 1, bytes: 4, health: "unavailable" }));
    expect(quarantined.problems).toEqual([
      { dimension: "quarantine-storage", detail: "preparation quarantine storage is unavailable" },
    ]);
    expect(quarantined.quarantine).toEqual({ count: 1, bytes: 4, health: "unavailable" });
    expect(quarantined.epoch.orphans.health).toBe("unavailable");
    const pruned = await scanPreparationInventoryFrom(storeOf().reads, lifecycleOf({}, { health: "unavailable" }));
    expect(pruned.problems).toEqual([]);
    expect(pruned.quarantine.health).toBe("ok");
  });
});

describe("inventory scan over its own reads: the caller's options and the entry bound", () => {
  it("N14 the active scan receives the caller's own options object", async () => {
    const options: PreparationScanOptions = {};
    const store = storeOf();
    await scanPreparationInventoryFrom(store.reads, lifecycleOf(), options);
    expect(store.log[1]?.[0]).toBe("active");
    expect(store.log[1]?.[1]).toBe(options);
  });

  it("N14 the limit is taken before the proof, and the same object is handed on after it", async () => {
    const options: PreparationScanOptions = { maxDirectoryEntriesForTest: 5 };
    const store = storeOf({ traversalEntries: 3, duringProof: () => { options.maxDirectoryEntriesForTest = 2; } });
    const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf(), options);
    expect(inventory.problems).toEqual([]);
    expect(store.log[1]?.[1]).toBe(options);
    expect(options.maxDirectoryEntriesForTest).toBe(2);
  });

  it("N5 active plus quarantine entries at the limit are no problem; one over is", async () => {
    const options: PreparationScanOptions = { maxDirectoryEntriesForTest: 5 };
    const at = await scanPreparationInventoryFrom(
      storeOf({ traversalEntries: 3 }).reads, lifecycleOf({ traversalEntries: 2 }), options);
    expect(at.problems).toEqual([]);
    const over = await scanPreparationInventoryFrom(
      storeOf({ traversalEntries: 3 }).reads, lifecycleOf({ traversalEntries: 3 }), options);
    expect(over.problems).toEqual([
      { dimension: "directory-entries", detail: "preparation inventory entry bound exceeded" },
    ]);
    expect(over.quarantine.health).toBe("unavailable");
  });
});

describe("inventory scan over its own reads: the order of the whole problem list", () => {
  it("C1 active problems come first in their own order, and the lifecycle problem comes LAST", async () => {
    const unreadable = preparedOf("unreadable");
    const dangling = preparedOf("dangling", "gone");
    const scanProblem = { dimension: "directory", detail: "SCAN-PROBLEM" };
    const store = storeOf({
      leaves: leavesOf(unreadable, dangling), manifests: [dangling.manifest], scanProblems: [scanProblem],
      traversalEntries: 3, run: { status: "absent" },
    });
    const read = lifecycleOf({ health: "unavailable", traversalEntries: 3 });
    const inventory = await scanPreparationInventoryFrom(store.reads, read, { maxDirectoryEntriesForTest: 5 });
    expect(inventory.problems).toEqual([
      scanProblem,
      { dimension: "directory-entries", detail: "preparation inventory entry bound exceeded" },
      {
        dimension: "manifest-state", detail: "preparation manifest is absent",
        path: path.join(".llmwiki", unreadable.manifestLeaf.relativePath),
      },
      { dimension: "supersession", detail: "preparation supersedes a dangling target" },
      { dimension: "run-state", detail: "preparation run is absent" },
      { dimension: "quarantine-storage", detail: "preparation quarantine storage is unavailable" },
    ]);
  });

  it("C1 an unavailable capture beside an unreadable manifest reports the manifest first", async () => {
    const unreadable = preparedOf("unreadable");
    const inventory = await scanPreparationInventoryFrom(
      storeOf({ leaves: leavesOf(unreadable) }).reads, UNAVAILABLE_READ);
    expect(inventory.problems.map((problem) => problem.dimension)).toEqual(["manifest-state", "lifecycle-storage"]);
  });
});

describe("inventory scan over its own reads: manifests", () => {
  it("C5 each non-ok manifest status is named exactly, with the leaf's path and never the store's detail", async () => {
    for (const manifestRead of NON_OK_MANIFESTS) {
      const record = preparedOf("one");
      const store = storeOf({ leaves: leavesOf(record), manifestRead });
      const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
      expect(inventory.problems, manifestRead.status).toEqual([{
        dimension: "manifest-state", detail: `preparation manifest is ${manifestRead.status}`,
        path: path.join(".llmwiki", record.manifestLeaf.relativePath),
      }]);
      expect(JSON.stringify(inventory.problems)).not.toContain("STORE-DETAIL");
      expect(inventory.manifests).toEqual([]);
      expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest"]);
    }
  });

  it("O2 a manifest leaf without ids, and a protocol alias, cost no manifest read", async () => {
    const leaves = [
      leafOf("manifest", "workspaces/ws-one/stray-manifest.json"),
      leafOf("manifest", "workspaces/ws-one/preparations/prp_x/manifest.json.tmp", {
        workspaceId: "ws-one", preparationId: "prp_x", protocolAlias: "tmp",
      }),
    ];
    const store = storeOf({ leaves });
    const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    expect(kindsOf(store.log)).toEqual(["proof", "active"]);
    expect(inventory.problems).toEqual([]);
  });

  it("C2 a dangling supersession target is one problem with its exact detail, and state reads continue", async () => {
    const dangling = preparedOf("dangling", "gone");
    const store = storeOf(completeStore([dangling]));
    const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    expect(inventory.problems).toEqual([
      { dimension: "supersession", detail: "preparation supersedes a dangling target" },
    ]);
    expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest", "key", "run"]);
    expect(inventory.manifests).toEqual([dangling.manifest]);
    expect(inventory.activeNonterminalRuns).toBe(1);
  });
});

describe("inventory scan over its own reads: one manifest's key and run", () => {
  it("N7 a manifest missing its evidence leaf or its run leaf costs no key read and no run read", async () => {
    const record = preparedOf("one");
    for (const leaves of [[record.manifestLeaf, record.runLeaf], [record.manifestLeaf, record.evidenceLeaf]]) {
      const store = storeOf({ leaves, manifests: [record.manifest] });
      const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
      expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest"]);
      expect(inventory.problems).toEqual([]);
      expect(inventory.activeNonterminalRuns).toBe(0);
      expect(inventory.epoch.orphans.count).toBe(2);
    }
  });

  it("C5 an absent or unavailable key is a run-state problem by name, and no run is read", async () => {
    for (const key of NON_OK_KEYS) {
      const store = storeOf(completeStore([preparedOf("one")], { key }));
      const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
      expect(inventory.problems).toEqual([{ dimension: "run-state", detail: `preparation key is ${key.status}` }]);
      expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest", "key"]);
    }
  });

  it("C5 an absent or unavailable run is a run-state problem by name, never the store's code or detail", async () => {
    for (const run of NON_OK_RUNS) {
      const store = storeOf(completeStore([preparedOf("one")], { run }));
      const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
      expect(inventory.problems).toEqual([{ dimension: "run-state", detail: `preparation run is ${run.status}` }]);
      expect(JSON.stringify(inventory.problems)).not.toMatch(/STORE-DETAIL|run-integrity-invalid/u);
      expect(inventory.activeNonterminalRuns).toBe(0);
    }
  });
});

describe("inventory scan over its own reads: read order, the binding and the run state", () => {
  it("N10 two complete manifests share one key read, then each run is read in manifest order with its own binding", async () => {
    const first = preparedOf("first");
    const second = preparedOf("second");
    const store = storeOf(completeStore([first, second]));
    await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    expect(store.log.slice(2)).toEqual([
      ["manifest", "ws-one", "prp_first"], ["manifest", "ws-one", "prp_second"],
      // The key epoch is one fact about the store: a scan reads it once and
      // authenticates every run against that same reading.
      ["key"], ["run", bindingOf(first.manifest)], ["run", bindingOf(second.manifest)],
    ]);
  });

  it("N10 the binding's manifest digest is computed AFTER the key read", async () => {
    const record = preparedOf("one");
    const digestBefore = preparationManifestDigest(record.manifest);
    const change = (): void => { (record.manifest as { createdAt: string }).createdAt = "2026-02-02T00:00:00.000Z"; };
    const store = storeOf(completeStore([record], { duringKeyRead: change }));
    await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    const binding = bindingOf(record.manifest);
    expect(binding.manifestDigest).not.toBe(digestBefore);
    expect(store.log[4]).toEqual(["run", binding]);
  });

  it("N11 only a run in a nonterminal state counts as an active nonterminal run", async () => {
    for (const [state, expected] of [["running", 1], ["recovery-required", 1], ["succeeded", 0], ["abandoned", 0]] as const) {
      const store = storeOf(completeStore([preparedOf("one")], { run: { status: "ok", run: runIn(state) } }));
      const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
      expect(inventory.activeNonterminalRuns, state).toBe(expected);
    }
  });
});

describe("inventory scan over its own reads: orphans, totals and health", () => {
  it("N12 leaves of an incomplete preparation and unknown leaves are orphans; a complete one's are not", async () => {
    const complete = preparedOf("complete");
    const incomplete = preparedOf("incomplete");
    const unknown = leafOf("unknown", "workspaces/ws-one/stray");
    const store = storeOf({
      leaves: [...leavesOf(complete), incomplete.manifestLeaf, incomplete.evidenceLeaf, unknown],
      manifests: [complete.manifest, incomplete.manifest],
    });
    const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    expect(inventory.epoch.orphans).toEqual({ count: 3, bytes: 3 * LEAF_BYTES, health: "ok" });
    expect(inventory.problems).toEqual([]);
  });

  it("N13 a clean complete store reports exact totals and ok health everywhere", async () => {
    const record = preparedOf("one");
    const inventory = await scanPreparationInventoryFrom(storeOf(completeStore([record])).reads, lifecycleOf());
    const one = { count: 1, bytes: LEAF_BYTES, health: "ok" };
    const none = { count: 0, bytes: 0, health: "ok" };
    expect(inventory.epoch).toEqual({ manifests: one, runs: one, evidence: one, cancelRequests: none, orphans: none });
    expect(inventory.quarantine).toEqual(none);
    expect(inventory.activeBytes).toBe(3 * LEAF_BYTES);
    expect(inventory.manifests).toEqual([record.manifest]);
    expect([...inventory.runIds]).toEqual(["prr_one"]);
  });

  it("N13 any problem makes every epoch entry unavailable and leaves its counts exact", async () => {
    const record = preparedOf("one");
    const store = storeOf(completeStore([record], { scanProblems: [{ dimension: "directory", detail: "SCAN-PROBLEM" }] }));
    const inventory = await scanPreparationInventoryFrom(store.reads, lifecycleOf());
    const one = { count: 1, bytes: LEAF_BYTES, health: "unavailable" };
    const none = { count: 0, bytes: 0, health: "unavailable" };
    expect(inventory.epoch).toEqual({ manifests: one, runs: one, evidence: one, cancelRequests: none, orphans: none });
    expect(inventory.quarantine).toEqual(none);
  });
});

describe("inventory scan over its own reads: a rejecting read is not caught", () => {
  it("N15 a rejecting active scan rejects with the same object, after the proof", async () => {
    const store = storeOf();
    const reads: PreparationInventoryReads = { ...store.reads, scanActiveStore: () => Promise.reject(BOOM) };
    await expect(scanPreparationInventoryFrom(reads, lifecycleOf())).rejects.toBe(BOOM);
    expect(kindsOf(store.log)).toEqual(["proof"]);
  });

  it("N15 a rejecting manifest read rejects with the same object", async () => {
    const store = storeOf(completeStore([preparedOf("one")]));
    const reads: PreparationInventoryReads = { ...store.reads, readManifest: () => Promise.reject(BOOM) };
    await expect(scanPreparationInventoryFrom(reads, lifecycleOf())).rejects.toBe(BOOM);
    expect(kindsOf(store.log)).toEqual(["proof", "active"]);
  });

  it("N15 a rejecting key read rejects with the same object, and no run is read", async () => {
    const store = storeOf(completeStore([preparedOf("one")]));
    const reads: PreparationInventoryReads = { ...store.reads, readKeyEpoch: () => Promise.reject(BOOM) };
    await expect(scanPreparationInventoryFrom(reads, lifecycleOf())).rejects.toBe(BOOM);
    expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest"]);
  });

  it("N15 a rejecting run read rejects with the same object", async () => {
    const store = storeOf(completeStore([preparedOf("one")]));
    const reads: PreparationInventoryReads = { ...store.reads, readRun: () => Promise.reject(BOOM) };
    await expect(scanPreparationInventoryFrom(reads, lifecycleOf())).rejects.toBe(BOOM);
    expect(kindsOf(store.log)).toEqual(["proof", "active", "manifest", "key"]);
  });
});

/** `storeOf` plus a borrow that logs the ceiling asked for, lends `lent` for the length of `use` (or rejects with it), and logs the return. */
function borrowingStoreOf(lent: PreparationLifecycleReadV1 | Error): { reads: PreparationInventoryLifecycleReads; log: unknown[][] } {
  const { reads, log } = storeOf();
  const borrowLifecycleRead: PreparationInventoryLifecycleReads["borrowLifecycleRead"] = async (maxRegistryEntries, use) => {
    log.push(["borrow", maxRegistryEntries]);
    if (lent instanceof Error) throw lent;
    try { return await use(lent); } finally { log.push(["returned"]); }
  };
  return { reads: { ...reads, borrowLifecycleRead }, log };
}

describe("inventory scan over its own reads: the one lifecycle borrow", () => {
  it("B1 one borrow, at the limit taken from the caller's options, with the whole scan inside it over the borrowed read", async () => {
    const read = lifecycleOf(), options = { maxDirectoryEntriesForTest: 7 }, store = borrowingStoreOf(read);
    expect((await scanPreparationInventoryBorrowingFrom(store.reads, options)).problems).toEqual([]);
    expect(store.log).toEqual([["borrow", 7], ["proof", read], ["active", options], ["returned"]]);
    expect([store.log[1]?.[1] === read, store.log[2]?.[1] === options]).toEqual([true, true]);
  });

  it("B2 with no options the ceiling is the host's, and an unavailable borrowed read becomes the one fixed problem", async () => {
    const store = borrowingStoreOf(UNAVAILABLE_READ);
    expect((await scanPreparationInventoryBorrowingFrom(store.reads)).problems).toEqual([{ dimension: "lifecycle-storage", detail: "preparation lifecycle capture is unavailable" }]);
    expect(store.log).toEqual([["borrow", preparationScanEntryLimit()], ["active", {}], ["returned"]]);
  });

  it("B3 a refused limit rejects before any borrow; a rejecting borrow is not caught; a rejection inside the scan leaves through the borrow", async () => {
    const refused = borrowingStoreOf(BOOM);
    await expect(scanPreparationInventoryBorrowingFrom(refused.reads, { maxDirectoryEntriesForTest: 0 })).rejects.toThrow("positive safe integer");
    await expect(scanPreparationInventoryBorrowingFrom(refused.reads)).rejects.toBe(BOOM);
    expect(refused.log).toEqual([["borrow", preparationScanEntryLimit()]]);
    const inside = borrowingStoreOf(lifecycleOf());
    await expect(scanPreparationInventoryBorrowingFrom({ ...inside.reads, assertLifecycleRead: () => Promise.reject(BOOM) })).rejects.toBe(BOOM);
    expect(kindsOf(inside.log)).toEqual(["borrow", "returned"]);
  });
});
