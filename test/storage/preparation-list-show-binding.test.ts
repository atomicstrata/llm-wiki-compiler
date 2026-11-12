/**
 * @file test/storage/preparation-list-show-binding.test.ts
 * @description The two preparation READ VERBS' real bodies,
 * `listPreparationsOperationFrom` and `showPreparationOperationFrom`, run with
 * no project directory. What is pinned is each verb's own decisions: the order
 * of its reads, what it does with readiness, the could-not-see taxonomy, the
 * listing's order, cap and reserved problem headroom, the request capture
 * before the first await, the reference-only report, and that the execution
 * owner's liveness is asked of the HOST and of nothing else.
 *
 * WHAT KIND OF TEST THIS IS. Once, before the cases, one preparation is staged
 * by the real writer in a directory this file has the shared temp-root tracker
 * create. Its records are copied into memory, both verbs are asked ONCE through
 * their root forms on that real disk, and the directory is removed. The main
 * cases then run each verb's body over the ACCEPTED lower bodies (readiness,
 * the profile loader, inventory scan, the store walk, key, manifest and run
 * readers, run lookup) composed over those copied records, and require the
 * SAME ANSWER the disk gave. No case is given a path, and one case shows the
 * directory is gone.
 *
 * THE WALK AND THE PROFILE LOADER REALLY RUN. The active store is walked by
 * `scanActivePreparationStoreFrom` over the store's own entries, copied as
 * plain names, sizes and inode numbers that have never been through the
 * scanner. The profile is loaded by `loadProfileFrom` over in-memory sources
 * with no product binding: an absent leaf, a real non-default profile, and
 * leaves the loader refuses.
 *
 * TWO CASES ARE SCRIPTED AT THE VERB'S OWN SEAM INSTEAD, and say so: the cap
 * case needs more than a hundred runs, and the owner case needs a run that
 * records an owner. Neither can be minted cheaply. They pin the verb's own
 * arithmetic and its report; they are not evidence about the lower bodies.
 *
 * WHAT THIS IS NOT. The in-memory leaves confine nothing and check no owner,
 * mode, link or cap. The lifecycle read is a double the test vouches for, so
 * this is NOT evidence of lifecycle capture, its lease or its provenance, and
 * no authority is established by it. The tree provider opens nothing: this is
 * NOT evidence of no-follow opening or handle-bound metadata. The profile
 * sources hold no product binding and no package, so product mode is not
 * exercised. The host double returns the
 * classification it is told to: this is NOT evidence about any real process.
 * The root forms' local-disk reads and the real process classifier are
 * exercised by the existing disk tests, not here. Nothing here selects a
 * backend, and no journey is closed by it.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { scanPreparationInventoryFrom, type PreparationInventoryReads } from "../../src/preparations/capacity.js";
import {
  readPreparationKeyEpochFrom, readPreparationKeyFrom, type PreparationKeyLeafReads,
} from "../../src/preparations/key-epoch.js";
import type { PreparationLifecycleReadV1 } from "../../src/preparations/lifecycle-snapshot/types.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import { readPreparationManifestFrom } from "../../src/preparations/manifest-store.js";
import { scanActivePreparationStoreFrom } from "../../src/preparations/orphan-scan.js";
import { readPreparationRunFrom, type PreparationRunLeafReads } from "../../src/preparations/run-store.js";
import type { PreparationExecutionOwnerV1, PreparationRunBinding } from "../../src/preparations/run-types.js";
import {
  MAX_PREPARATION_LIST_ITEMS, listPreparationsOperation, listPreparationsOperationFrom,
  type ListResultV1, type PreparationListReads,
} from "../../src/preparations/service-list.js";
import {
  resolvePreparationReadReadinessFrom, type PreparationReadinessReads,
} from "../../src/preparations/service-readiness.js";
import { REQUEST_CAPTURE_REFUSAL } from "../../src/preparations/service-request-capture.js";
import { resolvePreparationRunFrom, type PreparationRunLookupReads } from "../../src/preparations/service-run-lookup.js";
import {
  showPreparationOperation, showPreparationOperationFrom,
  type PreparationShowHostObservation, type PreparationShowReads, type ShowResultV1,
} from "../../src/preparations/service-show.js";
import { loadProfileFrom, type EffectiveProfileSources } from "../../src/profile/load.js";
import type { CappedTextNoFollowRead } from "../../src/storage/disk-handle-leaves.js";
import type { CappedLeafRead } from "../../src/utils/confined-read.js";
import { MAX_PROFILE_BYTES } from "../../src/utils/constants.js";
import type { OwnerLiveness } from "../../src/utils/lock-owner.js";
import { noBindingLeafDouble } from "../fixtures/no-binding-leaf-double.js";
import { tempRootTracker } from "../temp-roots.js";
import { kindsOf } from "./call-log.js";
import { runTextWithLastIntegrityDigitFlipped } from "./flipped-integrity.js";
import { treeReads, type TreeDirectory } from "./memory-store-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { mintPreparationRecords, type MintedPreparationRecords } from "./minted-preparation-records.js";

const OWN_PREFIX = "preparation-list-show-binding-";
const BOOM = new Error("the read rejected");
const UNKNOWN_RUN = "run_this-run-was-never-staged";
const SYNTHETIC_RUNS = 105;
const SYNTHETIC_RUN_LEAVES_SEEN = 200;
const SYNTHETIC_OBSERVED_PROBLEMS = 120;
const SECONDS_PER_MINUTE = 60;
const LIVENESS_CLASSES: readonly OwnerLiveness[] = [
  "live", "stale", "unobservable-unreadable", "unobservable-unrecorded", "unobservable-unrecognised",
];
const PROFILE_BROKEN = "the project profile is present but unreadable; preparation commands cannot proceed";
const SCAN_NOT_AUTHORITATIVE = "the preparation scan was not authoritative; this run may exist";
/** A valid profile that is NOT the built-in default. */
const NON_DEFAULT_PROFILE = JSON.stringify(
  { schemaVersion: 1, profileId: "legacy", displayName: "Legacy", entities: { notes: { directory: "wiki/notes" } } });
/** An open that failed because nothing is there. */
const NOTHING_THERE = Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
/** The profile leaf of a project that has no profile: the loader yields the built-in default. */
const NO_PROFILE_LEAF: CappedTextNoFollowRead = { kind: "not-opened", error: NOTHING_THERE };
/** Three profile leaves the real loader refuses: unparseable, a link it will not follow, and over the cap. */
const REFUSED_PROFILE_LEAVES: readonly CappedTextNoFollowRead[] = [
  { kind: "text", text: "{ not json" },
  { kind: "not-opened", error: Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" }) },
  { kind: "oversize", size: MAX_PROFILE_BYTES + 1 },
];
const EMPTY_STORAGE = { count: 0, bytes: 0, health: "ok", traversalEntries: 0 };
/** A lifecycle read THE TEST VOUCHES FOR, carrying only the empty storage the scan reads. */
const VOUCHED_LIFECYCLE = {
  status: "ok", snapshot: { storage: { quarantine: EMPTY_STORAGE, prune: EMPTY_STORAGE } },
} as unknown as PreparationLifecycleReadV1;
/** A host that fails the case if it is asked: for runs that record no owner. */
const HOST_NOT_ASKED: PreparationShowHostObservation = {
  classifyOwnerLiveness: () => { throw new Error("the host was asked about a run that records no owner"); },
};

/** What a case may change about the copied store. Everything else is the minted record. */
interface StoreScript {
  keyLeaf?: CappedLeafRead;
  runLeaf?: CappedLeafRead;
  storeLook?: () => Promise<"directory" | "not-directory">;
  /** The store's entries to walk, in place of the copied ones. */
  tree?: TreeDirectory;
  /** The profile leaf's answer, in place of "no profile". */
  profileLeaf?: CappedTextNoFollowRead;
}

let minted: MintedPreparationRecords;
let diskList: ListResultV1;
let diskShow: ShowResultV1;

/** Owns the one directory this file creates. Its cleanup removes only directories it created itself. */
const ownTemporaryRoots = tempRootTracker();

beforeAll(async () => {
  minted = await mintPreparationRecords(ownTemporaryRoots, OWN_PREFIX, async ({ dir, binding }) => {
    diskList = await listPreparationsOperation(dir);
    diskShow = await showPreparationOperation(dir, { runId: binding.runId });
  });
});

/** Legacy-profile sources held in memory: no product binding, and `leaf` as the profile leaf's answer. */
function profileSourcesOver(leaf: CappedTextNoFollowRead): EffectiveProfileSources {
  const activeProduct = { root: "/shown/never/opened", binding: noBindingLeafDouble(() => {}), packages: {} };
  return { activeProduct: activeProduct as unknown as EffectiveProfileSources["activeProduct"], readPrivateLeafText: async () => leaf };
}

/** The accepted lower bodies composed over the minted records, in memory: the listing's four reads. */
function memoryStore(script: StoreScript = {}): PreparationListReads {
  const keyLeaves: PreparationKeyLeafReads = {
    readKeyLeaf: async () => script.keyLeaf ?? { kind: "ok", body: minted.keyText },
  };
  const runLeaves: PreparationRunLeafReads = {
    readRunLeaf: async () => script.runLeaf ?? { kind: "ok", body: minted.runText },
    readKey: () => readPreparationKeyFrom(keyLeaves),
  };
  const readKeyEpoch = () => readPreparationKeyEpochFrom(keyLeaves);
  const readRun = (binding: PreparationRunBinding) => readPreparationRunFrom(runLeaves, binding);
  const inventoryReads: PreparationInventoryReads = {
    assertLifecycleRead: async () => {},
    scanActiveStore: (options) => scanActivePreparationStoreFrom(treeReads(script.tree ?? minted.storeTree).reads, options),
    readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(
      { manifestLeavesIn: () => async () => ({ kind: "ok", body: minted.manifestBytes }) }, workspaceId, preparationId),
    readKeyEpoch, readRun,
  };
  const readinessReads: PreparationReadinessReads = {
    observeStore: script.storeLook ?? (async () => "directory" as const),
    probeStore: async () => {},
    loadProfile: () => loadProfileFrom(profileSourcesOver(script.profileLeaf ?? NO_PROFILE_LEAF)),
    readKey: () => readPreparationKeyFrom(keyLeaves),
  };
  return {
    readReadiness: () => resolvePreparationReadReadinessFrom(readinessReads),
    scanInventory: () => scanPreparationInventoryFrom(inventoryReads, VOUCHED_LIFECYCLE),
    readKeyEpoch, readRun,
  };
}

/** `show`'s two reads over the same store: readiness, and the accepted lookup body over the store's reads. */
function showReadsOver(store: PreparationListReads): PreparationShowReads {
  const lookup: PreparationRunLookupReads = {
    scanInventory: store.scanInventory, readKeyEpoch: store.readKeyEpoch, readRun: store.readRun,
    readEvidenceBytes: () => Promise.reject(BOOM),
  };
  return { readReadiness: store.readReadiness, resolveRun: (runId) => resolvePreparationRunFrom(lookup, runId) };
}

/** The same reads, each appending its own name and arguments to `log` before it answers. */
function logged<Reads extends object>(reads: Reads, log: unknown[][]): Reads {
  const entries = Object.entries(reads).map(([name, read]): [string, unknown] => [name, (...args: unknown[]) => {
    log.push([name, ...args]);
    return (read as (...given: unknown[]) => unknown)(...args);
  }]);
  return Object.fromEntries(entries) as Reads;
}

/** A store look that fails the way a missing directory does. */
function storeIsMissing(): Promise<never> {
  return Promise.reject(NOTHING_THERE);
}

/** The copied store entries with one more leaf directly inside the staged workspace's directory. */
function storeTreeWithStrayLeaf(name: string): TreeDirectory {
  const tree = structuredClone(minted.storeTree);
  const workspaces = tree.entries.workspaces;
  const workspace = workspaces?.type === "directory" ? workspaces.entries[minted.binding.workspaceId] : undefined;
  if (workspace?.type !== "directory") throw new Error("the copied store has no directory for the staged workspace");
  workspace.entries[name] = { type: "file", size: 1, ino: 0 };
  return tree;
}

/** The one listed row, failing the case when the listing does not hold exactly one. */
function onlyRow(listing: ListResultV1): ListResultV1["runs"][number] {
  expect(listing.runs).toHaveLength(1);
  return listing.runs[0]!;
}

describe("list and show from memory: the fixture", () => {
  it("V0 the directory the records were minted in is gone, and the disk answers were real", () => {
    expectMintingDirectoryRemoved(minted.dir, OWN_PREFIX);
    expect(diskList.runs.map((row) => row.runId)).toEqual([minted.binding.runId]);
    expect(diskList.problems).toEqual([]);
    expect(diskShow.status).toBe("shown");
  });
});

describe("the real walk over the store's copied entries", () => {
  it("W1 the walk over the copied entries finds what the scan of the disk found", async () => {
    const scan = await scanActivePreparationStoreFrom(treeReads(minted.storeTree).reads);
    const comparable = (leaves: typeof scan.leaves) => leaves.map(({ dev: _device, ...rest }) => rest)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    expect(comparable(scan.leaves)).toEqual(comparable(minted.activeScan.leaves));
    expect([scan.workspaces, scan.preparationDirectories, scan.problems, scan.traversalEntries]).toEqual([
      minted.activeScan.workspaces, minted.activeScan.preparationDirectories, [], minted.activeScan.traversalEntries,
    ]);
  });

  it("W2 a leaf the scanner does not recognise is a listed problem with its path, and the run is still shown", async () => {
    const store = memoryStore({ tree: storeTreeWithStrayLeaf("stray.txt") });
    const listing = await listPreparationsOperationFrom(store);
    expect(listing.problems)
      .toContain(`preparation-entry: unknown preparation leaf (.llmwiki/workspaces/${minted.binding.workspaceId}/stray.txt)`);
    expect(onlyRow(listing)).toEqual(onlyRow(diskList));
    expect(await showPreparationOperationFrom(showReadsOver(store), HOST_NOT_ASKED, { runId: minted.binding.runId })).toEqual(diskShow);
  });

  it("W3 a store whose workspaces cannot be listed is could-not-see: a listed problem, and show is unavailable", async () => {
    const unlistable: TreeDirectory = { type: "directory", entries: { workspaces: { type: "directory", entries: {}, refuse: "unlistable" } } };
    const store = memoryStore({ tree: unlistable });
    const listing = await listPreparationsOperationFrom(store);
    expect(listing.runs).toEqual([]);
    expect(listing.problems).toContain("directory-unavailable: preparation directory cannot be listed (.llmwiki/workspaces)");
    expect(await showPreparationOperationFrom(showReadsOver(store), HOST_NOT_ASKED, { runId: minted.binding.runId }))
      .toEqual({ status: "unavailable", detail: SCAN_NOT_AUTHORITATIVE });
  });
});

describe("the real profile loader under both verbs", () => {
  it("P1 a real non-default profile is loaded, and both verbs answer as the disk did", async () => {
    const profileLeaf: CappedTextNoFollowRead = { kind: "text", text: NON_DEFAULT_PROFILE };
    const loaded = await loadProfileFrom(profileSourcesOver(profileLeaf));
    expect([loaded.profile.profileId, loaded.loadedFrom === null]).toEqual(["legacy", false]);
    const store = memoryStore({ profileLeaf });
    expect(await listPreparationsOperationFrom(store)).toEqual(diskList);
    expect(await showPreparationOperationFrom(showReadsOver(store), HOST_NOT_ASKED, { runId: minted.binding.runId })).toEqual(diskShow);
  });

  it("P2 a profile the loader refuses is a readiness problem for list and unavailable for show, which looks up no run", async () => {
    for (const profileLeaf of REFUSED_PROFILE_LEAVES) {
      const store = memoryStore({ profileLeaf });
      const listing = await listPreparationsOperationFrom(store);
      expect(listing.problems[0]).toBe(`project-readiness: ${PROFILE_BROKEN}`);
      expect(onlyRow(listing)).toEqual(onlyRow(diskList));
      const log: unknown[][] = [];
      expect(await showPreparationOperationFrom(logged(showReadsOver(store), log), HOST_NOT_ASKED, { runId: minted.binding.runId }))
        .toEqual({ status: "unavailable", detail: PROFILE_BROKEN });
      expect(kindsOf(log)).toEqual(["readReadiness"]);
    }
  });
});

describe("list from memory: the accepted bodies composed over real records", () => {
  it("L1 the listing equals the disk's, from four reads in order: readiness, scan, key, run", async () => {
    const log: unknown[][] = [];
    expect(await listPreparationsOperationFrom(logged(memoryStore(), log))).toEqual(diskList);
    expect(kindsOf(log)).toEqual(["readReadiness", "scanInventory", "readKeyEpoch", "readRun"]);
    expect(log[3]?.[1]).toEqual(minted.binding);
  });

  it("L2 a missing key leaves the run listed and unreadable, says so, and reads no run", async () => {
    const log: unknown[][] = [];
    const listing = await listPreparationsOperationFrom(logged(memoryStore({ keyLeaf: { kind: "absent" } }), log));
    expect(onlyRow(listing)).toMatchObject({ runId: minted.binding.runId, state: null, detail: "preparation key is absent" });
    expect(listing.problems).toContain("preparation key is absent");
    expect(kindsOf(log)).toEqual(["readReadiness", "scanInventory", "readKeyEpoch"]);
  });

  it("L3 an unreadable key is a readiness problem first, and still lists the run as unreadable", async () => {
    const listing = await listPreparationsOperationFrom(memoryStore({ keyLeaf: { kind: "unavailable" } }));
    expect(onlyRow(listing)).toMatchObject({ state: null, detail: "preparation key is unavailable" });
    expect(listing.problems[0]).toMatch(/^project-readiness: /);
    expect(listing.problems).toContain("preparation key is unavailable");
  });

  it("L4 an absent run leaf is a row detail AND a run-accounting problem", async () => {
    const listing = await listPreparationsOperationFrom(memoryStore({ runLeaf: { kind: "absent" } }));
    expect(onlyRow(listing)).toMatchObject({ state: null, detail: "manifest names an absent run" });
    expect(listing.problems).toContain("run-accounting: 1 manifest(s) name a run that is absent");
  });

  it("L5 a run whose integrity digit is flipped is listed with the run reader's own code", async () => {
    const flipped = runTextWithLastIntegrityDigitFlipped(minted.runText, minted.run.integrity);
    const store = memoryStore({ runLeaf: { kind: "ok", body: flipped } });
    const direct = await store.readRun(minted.binding);
    if (direct.status !== "unavailable") throw new Error("the flipped run was expected to be unavailable");
    expect(onlyRow(await listPreparationsOperationFrom(store))).toMatchObject({ state: null, detail: direct.code });
  });

  it("L6 a directory that is not a project is a problem, never a refusal: the run is still listed", async () => {
    const listing = await listPreparationsOperationFrom(memoryStore({ storeLook: storeIsMissing }));
    expect(listing.problems[0]).toMatch(/^project-readiness: /);
    expect(onlyRow(listing)).toEqual(onlyRow(diskList));
  });

  it("L7 a rejecting read is not caught: the listing rejects with the same object", async () => {
    for (const name of ["readReadiness", "scanInventory", "readKeyEpoch", "readRun"] as const) {
      const reads: PreparationListReads = { ...memoryStore(), [name]: () => Promise.reject(BOOM) };
      await expect(listPreparationsOperationFrom(reads)).rejects.toBe(BOOM);
    }
  });
});

/** `count` manifests that differ from the minted one only by run id and by a creation second that repeats. */
function syntheticManifests(count: number): PreparationManifestV1[] {
  return Array.from({ length: count }, (_, index): PreparationManifestV1 => ({
    ...minted.manifest,
    runId: `prr_${String(index).padStart(3, "0")}`,
    createdAt: `2026-01-01T00:00:${String(index % SECONDS_PER_MINUTE).padStart(2, "0")}.000Z`,
  }));
}

/** Reads SCRIPTED AT THE LISTING'S OWN SEAM: more runs than the cap, more observed problems than the cap. */
function overCapReads(): PreparationListReads {
  const entry = (count: number) => ({ count, bytes: 0, health: "ok" as const });
  const problems = Array.from({ length: SYNTHETIC_OBSERVED_PROBLEMS }, (_, index) => (
    { dimension: "manifest-state", detail: `planted ${String(index).padStart(3, "0")}` }));
  const epoch = {
    manifests: entry(SYNTHETIC_RUNS), runs: entry(SYNTHETIC_RUN_LEAVES_SEEN),
    evidence: entry(0), cancelRequests: entry(0), orphans: entry(0),
  };
  return {
    readReadiness: async () => ({ status: "ready" }),
    scanInventory: async () => ({ manifests: syntheticManifests(SYNTHETIC_RUNS), problems, epoch }),
    readKeyEpoch: async () => ({ status: "ok", keyEpochId: minted.key.keyEpochId }),
    readRun: async () => ({ status: "ok", run: minted.run }),
  };
}

describe("list over scripted reads: order, cap and reserved headroom", () => {
  it("L8 runs are newest first then by run id, capped with the true total and a flag", async () => {
    const listing = await listPreparationsOperationFrom(overCapReads());
    expect([listing.runs.length, listing.total, listing.truncated]).toEqual([MAX_PREPARATION_LIST_ITEMS, SYNTHETIC_RUNS, true]);
    const ids = listing.runs.map((row) => row.runId);
    expect(ids.slice(0, 2)).toEqual(["prr_059", "prr_058"]);
    expect(ids.slice(15, 17)).toEqual(["prr_044", "prr_104"]);
    expect(ids[MAX_PREPARATION_LIST_ITEMS - 1]).toBe("prr_002");
  });

  it("L9 the run-accounting line is never evicted by planted problems, and the problem counters are separate", async () => {
    const listing = await listPreparationsOperationFrom(overCapReads());
    expect(listing.problems[0])
      .toBe(`run-accounting: the scan saw ${SYNTHETIC_RUN_LEAVES_SEEN} run leaves but only ${SYNTHETIC_RUNS} could be listed`);
    expect(listing.problems).toHaveLength(MAX_PREPARATION_LIST_ITEMS);
    expect(listing.problems[1]).toBe("manifest-state: planted 000");
    expect([listing.problemTotal, listing.problemsTruncated]).toEqual([SYNTHETIC_OBSERVED_PROBLEMS + 1, true]);
  });
});

describe("show from memory: the accepted bodies composed over real records", () => {
  it("S1 the report equals the disk's, from two reads in order, and the host is not asked", async () => {
    const log: unknown[][] = [];
    const reads = logged(showReadsOver(memoryStore()), log);
    expect(await showPreparationOperationFrom(reads, HOST_NOT_ASKED, { runId: minted.binding.runId })).toEqual(diskShow);
    expect(log).toEqual([["readReadiness"], ["resolveRun", minted.binding.runId]]);
  });

  it("S2 a request with an accessor field is refused as the caller's input, before any read", async () => {
    const log: unknown[][] = [];
    const request = Object.defineProperty({}, "runId", { enumerable: true, get: () => minted.binding.runId });
    const reads = logged(showReadsOver(memoryStore()), log);
    expect(await showPreparationOperationFrom(reads, HOST_NOT_ASKED, request as { runId: string }))
      .toEqual({ status: "refused", reason: REQUEST_CAPTURE_REFUSAL });
    expect(log).toEqual([]);
  });

  it("S3 the run id is captured before the first await: a later change to the request is not seen", async () => {
    const request = { runId: minted.binding.runId as string };
    const pending = showPreparationOperationFrom(showReadsOver(memoryStore()), HOST_NOT_ASKED, request);
    request.runId = UNKNOWN_RUN;
    expect(await pending).toEqual(diskShow);
  });

  it("S4 a project that cannot be read is unavailable and one that is not there is refused; neither looks up a run", async () => {
    const outcomes: [StoreScript, ShowResultV1["status"]][] = [
      [{ keyLeaf: { kind: "unavailable" } }, "unavailable"], [{ storeLook: storeIsMissing }, "refused"],
    ];
    for (const [script, status] of outcomes) {
      const log: unknown[][] = [];
      const reads = logged(showReadsOver(memoryStore(script)), log);
      expect((await showPreparationOperationFrom(reads, HOST_NOT_ASKED, { runId: minted.binding.runId })).status).toBe(status);
      expect(kindsOf(log)).toEqual(["readReadiness"]);
    }
  });

  it("S5 a run that was never staged is refused, in the lookup's own words", async () => {
    const reads = showReadsOver(memoryStore());
    const direct = await reads.resolveRun(UNKNOWN_RUN);
    expect(direct).toMatchObject({ ok: false, failure: "denied" });
    if (direct.ok) throw new Error("an unknown run was expected to miss");
    expect(await showPreparationOperationFrom(reads, HOST_NOT_ASKED, { runId: UNKNOWN_RUN }))
      .toEqual({ status: "refused", reason: direct.reason });
  });

  it("S6 a run that cannot be authenticated is unavailable, not refused", async () => {
    const flipped = runTextWithLastIntegrityDigitFlipped(minted.runText, minted.run.integrity);
    const reads = showReadsOver(memoryStore({ runLeaf: { kind: "ok", body: flipped } }));
    const outcome = await showPreparationOperationFrom(reads, HOST_NOT_ASKED, { runId: minted.binding.runId });
    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ detail: expect.stringMatching(/^run is unreadable: /) });
  });
});

describe("show over a scripted lookup: the owner's liveness is the host's answer", () => {
  it("S7 each class is reported as the host gave it, asked once, after both reads, about the recorded owner", async () => {
    const owner: PreparationExecutionOwnerV1 = {
      pid: 4242, processStartTime: "as recorded", leaseNonce: "nonce", attemptId: "pat_attempt-1", acquiredAt: "2026-01-01T00:00:00.000Z",
    };
    const guidance = new Set<string>();
    for (const liveness of LIVENESS_CLASSES) {
      const log: unknown[][] = [];
      const reads = logged<PreparationShowReads>({
        readReadiness: async () => ({ status: "ready" }),
        resolveRun: async () => ({ ok: true, binding: minted.binding, run: { ...minted.run, executionOwner: owner } }),
      }, log);
      const host: PreparationShowHostObservation = {
        classifyOwnerLiveness: (asked) => { log.push(["host", asked]); return liveness; },
      };
      const outcome = await showPreparationOperationFrom(reads, host, { runId: minted.binding.runId });
      if (outcome.status !== "shown" || outcome.run.executionOwner === null) throw new Error("an owner report was expected");
      expect(outcome.run.executionOwner).toMatchObject({
        pid: owner.pid, attemptId: owner.attemptId, acquiredAt: owner.acquiredAt,
        liveness, retryable: liveness === "unobservable-unreadable",
      });
      expect(kindsOf(log)).toEqual(["readReadiness", "resolveRun", "host"]);
      expect(log[2]?.[1]).toBe(owner);
      guidance.add(outcome.run.executionOwner.guidance);
    }
    expect(guidance.size).toBe(LIVENESS_CLASSES.length);
  });
});
