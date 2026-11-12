/**
 * @file test/storage/provenance-store-binding.test.ts
 * @description The execution-provenance verifier and EVERYTHING UNDER IT, run
 * as one consumer over the preparation store's raw leaves with no project
 * directory. It uses `executionProvenanceReadsOver`, which exists only after
 * the verifier's reads were composed over leaves, so this file has NO
 * before-edit run.
 *
 * WHAT KIND OF TEST THIS IS. Once, before the cases, the real writer stages
 * one preparation in a directory this file's own tracker creates. Its key, its
 * manifest's bytes, its run leaf's text, the store's entries and the sealed
 * input's bytes are copied into memory. The verifier's ROOT FORM is asked four
 * times on that real disk, the last time after the run leaf was corrupted on
 * disk. The directory is then removed. Each case runs the real verifier body
 * over `executionProvenanceReadsOver` the copied leaves, and the first four
 * require the SAME VERDICT the disk gave.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The verifier; the run lookup and its miss
 * taxonomy; the sealed-input read and its decoding; the inventory scan; the
 * store walk; the manifest reader's parse and canonical check; the key
 * reader's decoding; the run reader's parse and its AUTHENTICATION against the
 * real key; and the evidence reader's digest check. No inventory, manifest,
 * run, key or verdict is handed in. These are the first runs, on disk or in
 * memory, of the verifier's sealed-input and run legs over a real store.
 *
 * WHAT IS NOT SHOWN, and it matters. NO RUN HERE VOUCHES: the staged run never
 * succeeded and admitted no provider output, so the `pass` verdict is not
 * reached; `execution-provenance-conjuncts.test.ts` shows it over a double
 * only. THE LIFECYCLE READ IS A DOUBLE THIS TEST VOUCHES FOR, and its proof
 * always resolves: this is NOT evidence of lifecycle capture, its lease or its
 * provenance, and no authority is established by it. The in-memory leaves
 * confine nothing and check no owner, mode, link or cap. Two cases are
 * scripted with no disk answer and say so. The leaves are not a hosted store,
 * not an access-control layer and not `ProjectStore`.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  executionProvenanceReadsOver, verifyExecutionProvenance, verifyExecutionProvenanceFrom,
  type ExecutionProvenanceVerdictV1,
} from "../../src/artifacts/execution-provenance.js";
import type { PreparationEvidenceLeafReads } from "../../src/preparations/evidence-store.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import type { PreparationStoreLeafReads } from "../../src/preparations/store-leaf-reads.js";
import type { ExecutionProvenanceReq } from "../../src/profile/types.js";
import { tamperRun } from "../preparations/lifecycle-fixture.js";
import { SEED_VALUE } from "../preparations/store-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { runTextWithLastIntegrityDigitFlipped } from "./flipped-integrity.js";
import { treeReads } from "./memory-store-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { mintPreparationRecords, type MintedPreparationRecords } from "./minted-preparation-records.js";
import { vouchedLifecycleRead } from "./preparation-store-doubles.js";

const OWN_PREFIX = "provenance-store-binding-";
/** The shared fixture plan's action, and the one field of its sealed input, taken as the slug field. */
const STAGED_ACTION = "compile";
const REQ: ExecutionProvenanceReq = { actionId: STAGED_ACTION, slugInputField: "seed", resultOutputId: "result" };
const STAGED_SLUG = SEED_VALUE.seed;
const PINNED = `sha256:${"a".repeat(64)}`;
const NOTHING_VOUCHES = (slug: string, actionId: string = STAGED_ACTION): ExecutionProvenanceVerdictV1 => ({
  verdict: "deny", detail: `no succeeded '${actionId}' run with seed=${JSON.stringify(slug)} admitted the pinned bytes under output 'result'`,
});
const ONE_PROBLEM: ExecutionProvenanceVerdictV1 = {
  verdict: "park", detail: "the preparation inventory reported 1 problem(s); provenance cannot be verified",
};

/** One leaf-level call, as the in-memory leaves log it. The store walk is not logged. */
type LeafCall = "borrow" | "assert" | "manifest" | "key" | "run-leaf" | "lend";
/** One inventory scan of a store that holds one staged preparation: the borrow and its proof, the manifest, the key epoch, then the run leaf and the key that authenticates it. */
const ONE_SCAN: readonly LeafCall[] = ["borrow", "assert", "manifest", "key", "run-leaf", "key"];

/** What the disk answered, each asked once through the verifier's root form. */
interface DiskVerdicts {
  staged: ExecutionProvenanceVerdictV1;
  otherSlug: ExecutionProvenanceVerdictV1;
  otherAction: ExecutionProvenanceVerdictV1;
  afterRunCorrupted: ExecutionProvenanceVerdictV1;
}
/** What a case serves from memory. Everything else is the minted record. */
interface StoreScript {
  runText: string;
  sealedInput: "held" | "absent" | Error;
  borrowFails?: Error;
}

let minted: MintedPreparationRecords;
let sealed: Buffer;
let disk: DiskVerdicts;
/** Owns the one directory this file creates. Its cleanup removes only directories it created itself. */
const ownRoots = tempRootTracker();

beforeAll(async () => {
  minted = await mintPreparationRecords(ownRoots, OWN_PREFIX, async ({ dir, binding, manifest }) => {
    const digest = manifest.plan.initialInputSet.digest.replace(/^sha256:/, "");
    sealed = await readFile(preparationPaths(dir, manifest.workspaceId).evidenceFile(manifest.preparationId, digest));
    const asked = (slug: string, req: ExecutionProvenanceReq = REQ) => verifyExecutionProvenance(dir, req, slug, PINNED);
    const [staged, otherSlug] = [await asked(STAGED_SLUG), await asked("another-slug")];
    const otherAction = await asked(STAGED_SLUG, { ...REQ, actionId: "another.action" });
    await tamperRun(dir, binding);
    disk = { staged, otherSlug, otherAction, afterRunCorrupted: await asked(STAGED_SLUG) };
  });
});
// Only matters when the hook above threw before the mint's own cleanup.
afterAll(() => ownRoots.cleanup());

/** The sealed input as one lent leaf: its held bytes, served by position, and never changed. */
function sealedLeaves(script: StoreScript, log: LeafCall[]): PreparationEvidenceLeafReads {
  return { useEvidenceLeaf: async (_location, _cleanDigest, use) => {
    log.push("lend");
    if (script.sealedInput instanceof Error) throw script.sealedInput;
    if (script.sealedInput === "absent") return { kind: "absent" };
    const value = await use({
      size: sealed.byteLength,
      read: async (target, offset, length, position) => ({ bytesRead: sealed.copy(target, offset, position, position + length) }),
      unchanged: async () => true,
    });
    return { kind: "used", value };
  } };
}

/** The store's raw leaves over the minted records, each logging its call before it answers. */
function memoryLeaves(script: StoreScript, log: LeafCall[]): PreparationStoreLeafReads {
  return {
    walk: treeReads(minted.storeTree).reads,
    manifests: { manifestLeavesIn: () => async () => { log.push("manifest"); return { kind: "ok", body: minted.manifestBytes }; } },
    key: { readKeyLeaf: async () => { log.push("key"); return { kind: "ok", body: minted.keyText }; } },
    runLeaves: { readRunLeaf: async () => { log.push("run-leaf"); return { kind: "ok", body: script.runText }; } },
    evidence: sealedLeaves(script, log),
    lifecycle: {
      borrowLifecycleRead: async (_maxRegistryEntries, use) => {
        log.push("borrow");
        if (script.borrowFails !== undefined) throw script.borrowFails;
        return use(vouchedLifecycleRead());
      },
      assertLifecycleRead: async () => { log.push("assert"); },
    },
  };
}

/** The real verifier over the composed reads over the copied leaves, with what a case changes. */
async function verifiedFromMemory(over: Partial<StoreScript> = {}, slug: string = STAGED_SLUG, req: ExecutionProvenanceReq = REQ) {
  const log: LeafCall[] = [];
  const script: StoreScript = { runText: minted.runText, sealedInput: "held", ...over };
  const verdict = await verifyExecutionProvenanceFrom(executionProvenanceReadsOver(memoryLeaves(script, log)), req, slug, PINNED);
  return { verdict, log };
}

describe("the provenance verifier over the store's raw leaves: the fixture", () => {
  it("P0 runs after the minting directory was removed, on a staged run that never succeeded", () => {
    expectMintingDirectoryRemoved(minted.dir, OWN_PREFIX);
    expect(minted.manifest.plan.actionAuthority.actionId).toBe(STAGED_ACTION);
    expect(JSON.parse(sealed.toString("utf8"))).toEqual(SEED_VALUE);
    expect(minted.run.state).not.toBe("succeeded");
    expect([disk.staged.verdict, disk.otherSlug.verdict, disk.otherAction.verdict, disk.afterRunCorrupted.verdict]).toEqual(["deny", "deny", "deny", "park"]);
  });
});

describe("the provenance verifier over the store's raw leaves: the same verdicts the disk gave", () => {
  it("P1 denies a staged run that never succeeded, reading its sealed input before its run and scanning again for the lookup", async () => {
    const { verdict, log } = await verifiedFromMemory();
    expect(verdict).toEqual(disk.staged);
    expect(verdict).toEqual(NOTHING_VOUCHES(STAGED_SLUG));
    expect(log).toEqual([...ONE_SCAN, "lend", ...ONE_SCAN, "key", "run-leaf", "key"]);
  });

  it("P2 denies another slug after the sealed input alone, and another action after the scan alone", async () => {
    const otherSlug = await verifiedFromMemory({}, "another-slug");
    expect(otherSlug.verdict).toEqual(disk.otherSlug);
    expect([otherSlug.verdict, otherSlug.log]).toEqual([NOTHING_VOUCHES("another-slug"), [...ONE_SCAN, "lend"]]);
    const otherAction = await verifiedFromMemory({}, STAGED_SLUG, { ...REQ, actionId: "another.action" });
    expect(otherAction.verdict).toEqual(disk.otherAction);
    expect([otherAction.verdict, otherAction.log]).toEqual([NOTHING_VOUCHES(STAGED_SLUG, "another.action"), ONE_SCAN]);
  });

  it("P3 parks when the run leaf does not authenticate against the real key, and reads no sealed input", async () => {
    const runText = runTextWithLastIntegrityDigitFlipped(minted.runText, minted.run.integrity);
    const { verdict, log } = await verifiedFromMemory({ runText });
    expect(verdict).toEqual(disk.afterRunCorrupted);
    expect([verdict, log]).toEqual([ONE_PROBLEM, ONE_SCAN]);
  });
});

describe("the provenance verifier over the store's raw leaves: scripted, with no disk answer", () => {
  it("P4 parks on a candidate whose sealed input is not there, and never reads its run", async () => {
    const { verdict, log } = await verifiedFromMemory({ sealedInput: "absent" });
    expect(verdict).toEqual({ verdict: "park", detail: "1 candidate run(s) could not be read; provenance cannot be verified" });
    expect(log).toEqual([...ONE_SCAN, "lend"]);
  });

  it("P5 parks on a scan that rejects, carrying its message, and lets a leaf's own rejection through as the same object", async () => {
    const refused = new Error("planted leaf failure");
    const scan = await verifiedFromMemory({ borrowFails: refused });
    expect([scan.verdict, scan.log]).toEqual([
      { verdict: "park", detail: "the preparation store could not be scanned: planted leaf failure" }, ["borrow"],
    ]);
    await expect(verifiedFromMemory({ sealedInput: refused })).rejects.toBe(refused);
  });
});
