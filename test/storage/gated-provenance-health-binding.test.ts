/**
 * @file test/storage/gated-provenance-health-binding.test.ts
 * @description An ARMED gated page's provenance check, run inside the REAL
 * profile summary over raw leaves copied off a real project, with no project
 * directory. It uses `collectProfileSummaryFrom` with the preparation store's
 * leaf reads as the summary's `provenance`, which exists only after artifact
 * health was handed those leaves, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk: the shared lifecycle
 * fixture stages one preparation with the real writer and key; then a profile
 * whose `complete` state requires a `result` artifact vouched for by a
 * succeeded `compile` run whose sealed `seed` input names the page; the
 * genuine trusted writer stores that artifact; and one page named after the
 * staged seed, in `complete`, pins it. The root-taking `collectProfileSummary`
 * answers twice: as staged, and with the run leaf corrupted by the shared
 * `tamperRun`, after which the original leaf text is written back. The tree is
 * copied as raw text and listings and the directory is removed before any case.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The summary, artifact health and its gate, the
 * artifact resolver, and under the provenance check the verifier with the
 * inventory scan, the store walk, the manifest, key and run readers, the
 * run's AUTHENTICATION against the real key, the run lookup and the sealed
 * input's digest check and decoding. No verdict, inventory or record is
 * handed in.
 *
 * WHAT IS NOT SHOWN. A passing verdict: the staged run never succeeded, so the
 * check denies, and no succeeded run is fabricated. THE LIFECYCLE READ IS ONE
 * THE TEST VOUCHES FOR (`preparation-store-doubles.ts`): nothing here is
 * evidence of lifecycle capture or its proof, which stay root-bound on disk.
 * The leaves confine nothing and check no owner, mode, link or cap. One case
 * is scripted with no disk answer and says so. Not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { readFile, realpath, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { preparationKeyFile, preparationPaths } from "../../src/preparations/paths.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { PreparationStoreLeafReads } from "../../src/preparations/store-leaf-reads.js";
import { collectProfileSummary, collectProfileSummaryFrom, type ProfileSummaryBlock, type ProfileSummarySources } from "../../src/profile/block.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import { seedArtifact } from "../fixtures/artifact-root.js";
import { writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { stagePreparation, tamperRun } from "../preparations/lifecycle-fixture.js";
import { SEED_VALUE } from "../preparations/store-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { artifactStoreOver } from "./artifact-store-double.js";
import { effectiveProfileOf, heldText, mintCopied, mintOnceThenRemove, type Copy, type Minted } from "./copied-project.js";
import { runTextWithLastIntegrityDigitFlipped } from "./flipped-integrity.js";
import { entitiesOver } from "./lint-sources-doubles.js";
import { treeReads, type TreeDirectory, type TreeNode } from "./memory-store-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { vouchedLifecycleRead } from "./preparation-store-doubles.js";

const PREFIX = "gated-provenance-health-";
/** The staged fixture's action, and its sealed input's one field naming the page. */
const STAGED_ACTION = "compile";
const PAGE_SLUG = SEED_VALUE.seed;
const RUNS_DIR = "wiki/experiments";
const STORE = ".llmwiki";
const REQUIRED = `field "result" required by lifecycle state "complete"`;
const DENIED = `${REQUIRED}: no succeeded '${STAGED_ACTION}' run with seed=${JSON.stringify(PAGE_SLUG)} admitted the pinned bytes under output 'result'`;
const PARKED = `${REQUIRED}: the preparation inventory reported 1 problem(s); provenance cannot be verified`;
const UNREADABLE = `${REQUIRED}: 1 candidate run(s) could not be read; provenance cannot be verified`;
/** One inventory scan of a store holding the one staged preparation, as the leaves log it. The walk is not logged. */
const ONE_SCAN = ["prep.borrow", "prep.assert", "prep.manifest", "prep.key", "prep.run-leaf", "prep.key"];

/** The shared research artifact profile, its `complete` requirement armed with the staged action. */
function armedProfile(): ProfilePack {
  const profile = researchArtifactPreconditionProfile();
  profile.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].executionProvenance =
    { actionId: STAGED_ACTION, slugInputField: "seed", resultOutputId: "result" };
  return profile;
}

/** What the disk answered: the real root, and the summary as staged and with the run leaf corrupted. */
interface OnDisk { real: string; staged: ProfileSummaryBlock | undefined; runCorrupted: ProfileSummaryBlock | undefined }
const tracker = tempRootTracker();
let project: Minted<OnDisk>;
let binding: PreparationRunBinding;

/** The staged preparation first, then the armed profile, the stored artifact and the page that pins it. */
async function seed(root: string): Promise<void> {
  ({ binding } = await stagePreparation(root));
  await writeProfileFile(root, armedProfile());
  const stored = formatArtifactRef(await seedArtifact(root, RESEARCH_ARTIFACT_TYPE, "probe", `{"accuracy":0.9}`));
  await writeMarkdownPage(root, RUNS_DIR, PAGE_SLUG, `---\ntitle: Probe\nstage: complete\nresult: ${stored}\n---\n\nThe probe run, described.\n`);
}

/** Ask the real summary as staged, then with the run leaf corrupted, then put the leaf back as it was. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const runFile = preparationPaths(root, binding.workspaceId).runFile(binding.runId);
  const original = await readFile(runFile, "utf8");
  const staged = await collectProfileSummary(root);
  await tamperRun(root, binding);
  const runCorrupted = await collectProfileSummary(root);
  await writeFile(runFile, original, "utf8");
  return { real: await realpath(root), staged, runCorrupted };
}

mintOnceThenRemove(tracker, async () => { project = await mintCopied(tracker, PREFIX, seed, askedOnDisk); });

/** The copied store's entries below `rel`, as the store walk's tree: names, kinds, sizes and a distinct identity per leaf. */
function treeOf(copy: Copy, rel: string, next: { ino: number } = { ino: 1 }): TreeDirectory {
  const entries: Record<string, TreeNode> = {};
  for (const entry of copy.listings.get(rel) ?? []) {
    const child = `${rel}/${entry.name}`;
    if (entry.kind === "directory") entries[entry.name] = treeOf(copy, child, next);
    else entries[entry.name] = { type: entry.kind, size: Buffer.byteLength(copy.files.get(child) ?? ""), ino: next.ino++ };
  }
  return { type: "directory", entries };
}

/** The preparation store's raw leaves over the copy, each logged before it answers. `runText` and `sealed` replace what the copy holds. */
function preparationLeavesOver(copy: Copy, log: string[], over: { runText?: string; sealed?: "absent" } = {}): PreparationStoreLeafReads {
  const held = (call: string, rel: string): string => { log.push(`prep.${call}`); return heldText(copy, rel); };
  return {
    walk: treeReads({ type: "directory", entries: { workspaces: treeOf(copy, `${STORE}/workspaces`) } }).reads,
    manifests: { manifestLeavesIn: (workspaceId) => async (preparationId) =>
      ({ kind: "ok", body: Buffer.from(held("manifest", preparationPaths("", workspaceId).manifestFile(preparationId))) }) },
    key: { readKeyLeaf: async () => ({ kind: "ok", body: held("key", preparationKeyFile("")) }) },
    runLeaves: { readRunLeaf: async (run) => {
      const text = held("run-leaf", preparationPaths("", run.workspaceId).runFile(run.runId));
      return { kind: "ok", body: over.runText ?? text };
    } },
    evidence: { useEvidenceLeaf: async (location, cleanDigest, use) => {
      log.push("prep.lend");
      if (over.sealed === "absent") return { kind: "absent" };
      const bytes = Buffer.from(heldText(copy, preparationPaths("", location.workspaceId).evidenceFile(location.preparationId, cleanDigest)));
      const value = await use({
        size: bytes.byteLength, unchanged: async () => true,
        read: async (target, offset, length, position) => ({ bytesRead: bytes.copy(target, offset, position, position + length) }),
      });
      return { kind: "used", value };
    } },
    lifecycle: {
      borrowLifecycleRead: async (_maxRegistryEntries, use) => { log.push("prep.borrow"); return use(vouchedLifecycleRead()); },
      assertLifecycleRead: async () => { log.push("prep.assert"); },
    },
  };
}

/** The real summary over the copy, with the preparation leaves as its provenance. */
async function summarizedFromMemory(over: Parameters<typeof preparationLeavesOver>[2] = {}) {
  const log: string[] = [];
  const note = (call: string): void => { log.push(call); };
  const { scans, graph, events, pages } = entitiesOver(project, note);
  const sources: ProfileSummarySources = {
    profile: effectiveProfileOf(project.copy, note), scans, graph, events, pages,
    artifacts: artifactStoreOver(project.copy.files, note),
    provenance: preparationLeavesOver(project.copy, log, over),
    realRoot: async () => project.onDisk.real,
  };
  return { block: await collectProfileSummaryFrom(sources), prep: log.filter((call) => call.startsWith("prep.")) };
}

const provenanceMessages = (block: ProfileSummaryBlock | undefined): string[] =>
  (block?.problems ?? []).filter((entry) => entry.message.startsWith(`${REQUIRED}:`)).map((entry) => entry.message);

describe("an armed gated page's provenance, inside the profile summary over copied leaves", () => {
  it("G0 runs after the minting directory was removed, on disk answers that deny as staged and park once the run was corrupted", () => {
    expectMintingDirectoryRemoved(project.dir, PREFIX);
    expect(heldText(project.copy, `${RUNS_DIR}/${PAGE_SLUG}.md`)).toContain("stage: complete");
    expect([provenanceMessages(project.onDisk.staged), provenanceMessages(project.onDisk.runCorrupted)]).toEqual([[DENIED], [PARKED]]);
  });

  it("G1 denies exactly as the disk did, scanning, reading the sealed input, then scanning again for the authenticated run", async () => {
    const { block, prep } = await summarizedFromMemory();
    expect(block).toEqual(project.onDisk.staged);
    expect(prep).toEqual([...ONE_SCAN, "prep.lend", ...ONE_SCAN, "prep.key", "prep.run-leaf", "prep.key"]);
  });

  it("G2 parks exactly as the disk did when the run leaf no longer authenticates against the real key", async () => {
    const runText = heldText(project.copy, preparationPaths("", binding.workspaceId).runFile(binding.runId));
    const integrity = (JSON.parse(runText) as { integrity: string }).integrity;
    const { block, prep } = await summarizedFromMemory({ runText: runTextWithLastIntegrityDigitFlipped(runText, integrity) });
    expect(block).toEqual(project.onDisk.runCorrupted);
    expect(prep).toEqual(ONE_SCAN);
  });

  it("G3 parks a candidate whose sealed input is not there, without reading its run (scripted, no disk answer)", async () => {
    const { block, prep } = await summarizedFromMemory({ sealed: "absent" });
    expect(provenanceMessages(block)).toEqual([UNREADABLE]);
    expect(prep).toEqual([...ONE_SCAN, "prep.lend"]);
  });
});
