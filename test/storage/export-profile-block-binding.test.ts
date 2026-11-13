/**
 * @file test/storage/export-profile-block-binding.test.ts
 * @description The JSON export's WHOLE profile block, `buildExportProfileBlockFrom`,
 * with no project directory. This file uses `buildExportProfileBlockFrom`,
 * which exists only after the export block was given sources to read through,
 * so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once: an empty
 * directory (the built-in default profile); a gated project with a legacy
 * custom profile, four entity pages and one relation written by the real
 * relation writer; and an artifact project (the shared research artifact
 * profile) whose one artifact is written by the genuine writer, pinned by a
 * `complete` experiment and by a relation attribute, and then has its body
 * swapped. For each, the real `buildExportProfileBlock(root)` answers
 * on disk, every regular file's text and every directory listing is COPIED
 * into memory, and the directories are removed before any case runs. Each case
 * then runs the export body over that copy and requires the answer the disk gave.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The export body, and under it the REAL lower
 * bodies: the default-profile gate with the legacy profile's load and
 * validation, the content-bearing entity collection and its problem views,
 * the live-valid relation read with the relation store's checksum rules, the
 * standing check with its endpoint page read, and artifact health with the
 * artifact resolver over the copied sidecar and body. No answer is replayed or
 * written by hand.
 *
 * WHAT THE DOUBLES DECIDE (`export-profile-doubles.ts`). Only what a copy can: whether a path is held, what a
 * directory lists, and a held file's text. The profile binding leaf is answered
 * `absent` (the shared `noBindingLeafDouble`), and the first case shows the
 * copies hold none. The preparation store is NEVER ASKED: neither profile arms
 * an execution-provenance requirement, so no verdict, pass or authentication
 * is claimed here. Every double logs its call under the step it serves.
 *
 * NOT SHOWN HERE: anything the local disk decides (confinement, links, size
 * caps, no-follow opens), a fail-closed relation store, an unreadable endpoint
 * page, or the preparation store's lifecycle authority. `profile-export.test.ts`,
 * `artifacts/artifact-health-surfaces.test.ts`, `profile-summary-binding.test.ts`
 * and `gated-provenance-health-binding.test.ts` show those.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { artifactPaths } from "../../src/artifacts/store.js";
import type { JsonExportProfileBlock } from "../../src/export/json-export.js";
import { buildExportProfileBlock, buildExportProfileBlockFrom } from "../../src/export/profile-block.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { appendRelation } from "../../src/relations/store.js";
import { LLMWIKI_DIR, PROFILE_FILE, WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_FILE, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import { seedArtifact } from "../fixtures/artifact-root.js";
import { genericGatedProfile, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { expectRemovedDefaultCopies, mintCopied, mintOnceThenRemove, stepsOf, type Copy, type Minted } from "./copied-project.js";
import { exportProfileSourcesOf } from "./export-profile-doubles.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "export-profile-block-";
const REAL_ROOT = "/memory/real/root";
const GATED = genericGatedProfile();
/** The shared research artifact profile (a `complete` experiment needs a `result` ref; no provenance is armed), with a `pins` relation whose `proof` attribute pins an artifact too. */
const ARTIFACTS: ProfilePack = researchArtifactPreconditionProfile();
ARTIFACTS.relations = { pins: { direction: "directed", from: ["experiments"], to: ["experiments"], attributes: { proof: { type: "artifactRef", artifactTypes: [RESEARCH_ARTIFACT_TYPE] } } } };
const page = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`;

type Block = JsonExportProfileBlock | undefined;
const tracker = tempRootTracker();
let plain: Minted<Block>;
let gated: Minted<Block>;
let artifact: Minted<Block>;

/** Mint one project with `seed`, take the disk's export block and a copy; the tracker removes the directory later. */
const mint = (seed: (root: string) => Promise<void>): Promise<Minted<Block>> => mintCopied(tracker, PREFIX, seed, buildExportProfileBlock);

/** The gated profile; a bonded and an unbonded sealed `alpha`, an `alpha` missing its required field, one `beta`; one `bonds` relation. */
async function seedGated(root: string): Promise<void> {
  await writeProfileFile(root, GATED);
  await writeMarkdownPage(root, "wiki/beta", "b1", page("title: Beta One"));
  await writeMarkdownPage(root, "wiki/alpha", "a1", page("title: Alpha One\nmode: sealed"));
  await writeMarkdownPage(root, "wiki/alpha", "a2", page("title: Alpha Two\nmode: sealed"));
  await writeMarkdownPage(root, "wiki/alpha", "bad", page("title: No Mode"));
  await appendRelation(root, GATED, { type: "bonds", from: "alpha/a1" as EntityId, to: "beta/b1" as EntityId, attributes: {} });
}

/** One artifact through the genuine writer, pinned by a `complete` experiment and by a relation attribute, then its body swapped for one of equal length (the sidecar left stale). */
async function seedArtifactProject(root: string): Promise<void> {
  await writeProfileFile(root, ARTIFACTS);
  const ref = formatArtifactRef(await seedArtifact(root, RESEARCH_ARTIFACT_TYPE, "probe", `{"accuracy":0.9}`));
  await writeMarkdownPage(root, "wiki/experiments", "e1", page(`title: Probe\nstage: complete\nresult: ${ref}`));
  await writeMarkdownPage(root, "wiki/experiments", "e2", page("title: Follow\nstage: running"));
  await appendRelation(root, ARTIFACTS, { type: "pins", from: "experiments/e1" as EntityId, to: "experiments/e2" as EntityId, attributes: { proof: ref } });
  await writeFile(artifactPaths(root, RESEARCH_ARTIFACT_TYPE, "probe", RESEARCH_ARTIFACT_FILE).bytesPath, `{"accuracy":0.1}`);
}

mintOnceThenRemove(tracker, async () => {
  plain = await mint(async () => {});
  gated = await mint(seedGated);
  artifact = await mint(seedArtifactProject);
});

/** The export body over one copy, with its ordered log. */
async function exported(copy: Copy): Promise<{ block: Block; log: string[] }> {
  const log: string[] = [];
  return { block: await buildExportProfileBlockFrom(exportProfileSourcesOf(copy, REAL_ROOT, log)), log };
}

describe("the export profile block over copied projects, with the directories gone", () => {
  it("X1 runs after every minting directory was removed; only the typed copies hold a profile, and none a binding leaf", () => {
    expectRemovedDefaultCopies([plain], PREFIX);
    for (const typed of [gated, artifact]) {
      expectMintingDirectoryRemoved(typed.dir, PREFIX);
      expect([typed.copy.files.has(PROFILE_FILE), typed.copy.files.has(`${LLMWIKI_DIR}/active-product.json`)]).toEqual([true, false]);
    }
  });

  it("X2 answers the built-in default with no block, as the disk did, and asks nothing after the profile", async () => {
    const { block, log } = await exported(plain.copy);
    expect([plain.onDisk, block]).toEqual([undefined, undefined]);
    expect(stepsOf(log)).toEqual(["profile"]);
  });

  it("X3 answers a gated project exactly as the disk did: pages with bodies, the relation, the entity and standing problems", async () => {
    const { block, log } = await exported(gated.copy);
    expect(block).toEqual(gated.onDisk);
    expect(block?.entityPages.filter((view) => typeof view.body !== "string")).toEqual([]);
    expect(block?.entityPages.map((view) => view.path)).toEqual(expect.arrayContaining(["wiki/beta/b1.md", "wiki/alpha/a1.md", "wiki/alpha/a2.md"]));
    expect(block?.relations?.map((view) => [view.type, view.from, view.to])).toEqual([["bonds", "alpha/a1", "beta/b1"]]);
    expect(block?.problems?.map((problem) => problem.kind)).toEqual(["field-violation", "lifecycle-relation-requirement-unmet"]);
    expect(stepsOf(log)).toEqual(["profile", "scans", "real", "graph", "scans", "graph", "pages"]);
  });

  it("X4 answers an artifact project exactly as the disk did: the swapped body is a problem for the page and for the relation", async () => {
    const { block, log } = await exported(artifact.copy);
    expect(block).toEqual(artifact.onDisk);
    const health = block?.problems?.filter((problem) => problem.kind === "artifact-store") ?? [];
    expect(health.map((problem) => problem.path)).toEqual(["wiki/experiments/e1.md", `${WIKI_GRAPH_DIR}/relations.jsonl`]);
    expect(health.filter((problem) => !problem.message.includes("(artifact-bytes-tampered)"))).toEqual([]);
    expect(stepsOf(log)).toEqual(["profile", "scans", "real", "graph", "artifacts", "graph", "artifacts", "real"]);
  });
});
