/**
 * @file test/storage/artifact-health-binding.test.ts
 * @description Artifact health under the REAL lint coordinator and the REAL
 * health score, with no project directory. It uses `resolveArtifactRefFrom`
 * through `lintBothViewsFrom` and `evaluateHealthFrom`, which reach the
 * artifact resolver over raw leaf reads only after the health check was handed
 * the artifact store's reads, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk under one profile
 * that declares an artifact type, a page field that pins it and a relation
 * attribute that pins it. In each, the genuine trusted writer stores ONE
 * artifact, one page pins it and one relation pins it again. The first is left
 * whole. In the second the body leaf is overwritten with different bytes of
 * the same length. In the third the sidecar is removed. The root-taking
 * `lintBothViews` and `evaluateHealth` answer on disk, each tree is copied as
 * raw text and listings, and every directory is removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The whole lint coordinator, the profile
 * appendix, the artifact health check, and under it the artifact resolver: the
 * declared-type gate, the sidecar parse, the hash of the body, the verdict
 * ladder. The score's deductions run on those findings. No health, verdict or
 * finding is handed in: the artifact double serves the two leaves the copy
 * holds and nothing else.
 *
 * WHAT IS NOT SHOWN. Execution provenance: no page here is in a gated state, so
 * the health check never runs the verifier and the preparation store's leaves
 * fail the case if asked. On disk the check runs the verifier over the
 * preparation store's raw leaves, whose lifecycle read and proof stay
 * root-bound; `gated-provenance-health-binding.test.ts` shows an armed page.
 * Member-bearing artifacts, oversize bodies and sidecars
 * that lie: `artifact-resolver-binding.test.ts` shows the resolver on those.
 * Anything about the disk: the doubles confine nothing and open nothing. The
 * doubles are those of `lint-sources-doubles.ts` and `artifact-store-double.ts`
 * plus a journal read from the copy. They are not a store, not an
 * access-control layer and not `ProjectStore`.
 */

import { realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import { evaluateHealth, evaluateHealthFrom } from "../../src/eval/health.js";
import type { HealthResult } from "../../src/eval/types.js";
import { lintBothViews, lintBothViewsFrom } from "../../src/linter/index.js";
import type { LintSources } from "../../src/linter/lint-sources.js";
import type { LintResult } from "../../src/linter/types.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { appendRelation } from "../../src/relations/store.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../src/utils/constants.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_FILE, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import { seedArtifact } from "../fixtures/artifact-root.js";
import { writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { artifactBodyLeaf, artifactStoreOver, type ArtifactLeafLookup } from "./artifact-store-double.js";
import { heldText, mintCopied, mintOnceThenRemove, unasked, type Copy, type Minted } from "./copied-project.js";
import { entitiesOver, lintSourcesOver } from "./lint-sources-doubles.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "artifact-health-";
const KIND = RESEARCH_ARTIFACT_TYPE;
const SLUG = "probe";
/** The body the writer stores, and different bytes of the SAME length. */
const WRITTEN = `{"accuracy":0.75}`;
const SWAPPED = `{"accuracy":0.25}`;
const BODY_LEAF = artifactBodyLeaf(KIND, SLUG, RESEARCH_ARTIFACT_FILE);
const SIDECAR_LEAF = `${BODY_LEAF}.manifest.json`;
/** The ref the page and the relation pin, worked out by hand from the written body. */
const PINNED = formatArtifactRef({ artifactType: KIND, slug: SLUG, sha256: hashArtifactBody(WRITTEN) });
const RUNS_DIR = "wiki/experiments";
const PINNING_PAGE = `${RUNS_DIR}/run-a.md`;
const RELATION_STORE = "wiki/graph/relations.jsonl";
/** One resolve, as the resolver's leaf reads: the location, the sidecar, then the body, each under its cap. */
const LEAF_READS = [
  `artifacts.artifactAt ${KIND}/${SLUG} ${RESEARCH_ARTIFACT_FILE}`, `artifacts.manifest ${KIND}/${SLUG} max=65536`, `artifacts.body ${KIND}/${SLUG} max=65536`,
];

/** The shared research artifact profile, with a `supports` relation whose `proof` attribute pins an artifact too. */
function profileWithProof(): ProfilePack {
  const profile = researchArtifactPreconditionProfile();
  const proof = { type: "artifactRef" as const, artifactTypes: [KIND] };
  profile.relations = { supports: { from: ["experiments"], to: ["experiments"], direction: "directed", attributes: { proof } } };
  return profile;
}
const PROFILE = profileWithProof();
/** One `experiments` page that is not in a gated state, with any further frontmatter lines. */
const runPage = (title: string, moreFront = ""): string => `---\ntitle: ${title}\nstage: running\n${moreFront}---\n\nThis run is described in enough words to count as a page.\n`;

/** What is done to the stored artifact after the writer has finished. */
type Damage = "none" | "swapped-body" | "no-sidecar";
/** What the disk answered for one project. */
interface OnDisk { real: string; views: Awaited<ReturnType<typeof lintBothViews>>; health: HealthResult }

/** The profile, one artifact through the genuine writer, the page and the relation that pin it, then the damage. */
async function seedProject(root: string, damage: Damage): Promise<void> {
  await writeProfileFile(root, PROFILE);
  const stored = formatArtifactRef(await seedArtifact(root, KIND, SLUG, WRITTEN));
  await writeMarkdownPage(root, RUNS_DIR, "run-a", runPage("Run A", `result: ${stored}\n`));
  await writeMarkdownPage(root, RUNS_DIR, "run-b", runPage("Run B"));
  await appendRelation(root, PROFILE, {
    type: "supports", from: "experiments/run-a" as EntityId, to: "experiments/run-b" as EntityId, attributes: { proof: stored },
  });
  if (damage === "swapped-body") await writeFile(path.join(root, BODY_LEAF), SWAPPED);
  if (damage === "no-sidecar") await rm(path.join(root, SIDECAR_LEAF));
}

/** Ask the real root-taking coordinator and the real root-taking score. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  return { real: await realpath(root), views: await lintBothViews(root), health: await evaluateHealth(root) };
}

const tracker = tempRootTracker();
let whole: Minted<OnDisk>;
let swapped: Minted<OnDisk>;
let bare: Minted<OnDisk>;
const mint = (damage: Damage): Promise<Minted<OnDisk>> => mintCopied(tracker, PREFIX, (root) => seedProject(root, damage), askedOnDisk);

mintOnceThenRemove(tracker, async () => {
  whole = await mint("none");
  swapped = await mint("swapped-body");
  bare = await mint("no-sidecar");
});

/** The journal as the copy holds it: absent with no directory, else its batch names and texts. No batch here is pending, so no target is asked about. */
function journalOver(copy: Copy): LintSources["journal"] {
  const dir = `${LLMWIKI_DIR}/journal`;
  const leafOf = (batchId: string): string => `${dir}/${batchId}.json`;
  return { openJournal: async () => {
    const listed = copy.listings.get(dir);
    if (listed === undefined) return { kind: "absent" };
    return { kind: "ok", journal: {
      listNames: async () => listed.map((entry) => entry.name),
      readBatchText: async (batchId) => (copy.files.has(leafOf(batchId)) ? heldText(copy, leafOf(batchId)) : null),
      targetConfined: unasked("journal.targetConfined"),
    } };
  } };
}

/** Every lint source over one copy. The artifact leaves are the copy's own files unless a case hands in others. */
function sourcesOver(project: Minted<OnDisk>, log: string[], leaves: ArtifactLeafLookup = project.copy.files): LintSources {
  const note = (call: string): void => { log.push(call); };
  const entities = entitiesOver(project, note);
  entities.artifacts = { ...entities.artifacts, artifacts: artifactStoreOver(leaves, note) };
  return lintSourcesOver(project, log, entities, { journal: journalOver(project.copy) });
}

/** The artifact health findings only: rule, severity and the file each is reported under. */
const healthFindings = (results: readonly LintResult[]): string[][] =>
  results.filter((one) => one.rule.startsWith("artifact-")).map((one) => [one.rule, one.severity, one.file]);
/** Both findings one unhealthy artifact raises here: the page that pins it, then the relation store. */
const twice = (project: Minted<OnDisk>, rule: string): string[][] => [[rule, "error", `${project.onDisk.real}/${PINNING_PAGE}`], [rule, "error", RELATION_STORE]];
/** The log from the first artifact read on. */
const fromFirstResolve = (log: string[]): string[] => log.slice(log.indexOf(LEAF_READS[0]));
const scoredRule = (health: HealthResult, rule: string): unknown[] => health.rules.filter((one) => one.rule === rule).map((one) => [one.count, one.severity, one.deduction]);

describe("artifact health under the lint coordinator, over copied projects with the directories gone", () => {
  it("G1 runs after the three minting directories were removed, on copies that hold what the writer and the damage left", () => {
    const all = [whole, swapped, bare];
    for (const one of all) expectMintingDirectoryRemoved(one.dir, PREFIX);
    expect(all.map((one) => [one.copy.files.has(PROFILE_FILE), heldText(one.copy, PINNING_PAGE).includes(PINNED)])).toEqual([[true, true], [true, true], [true, true]]);
    expect(all.map((one) => one.copy.files.get(BODY_LEAF))).toEqual([WRITTEN, SWAPPED, WRITTEN]);
    expect(all.map((one) => one.copy.files.has(SIDECAR_LEAF))).toEqual([true, true, false]);
    expect(SWAPPED).toHaveLength(WRITTEN.length);
    // The sidecar is the writer's own, and still records the body it wrote.
    expect(JSON.parse(heldText(swapped.copy, SIDECAR_LEAF))).toMatchObject({ artifactType: KIND, slug: SLUG, bytes: WRITTEN.length, sha256: hashArtifactBody(WRITTEN) });
  });

  it("G2 finds a whole artifact healthy exactly as the disk did, reading the sidecar before the body, for the page and then for the relation", async () => {
    const log: string[] = [];
    const views = await lintBothViewsFrom(sourcesOver(whole, log));
    expect(views).toEqual(whole.onDisk.views);
    expect(healthFindings(views.summary.results)).toEqual([]);
    expect(fromFirstResolve(log)).toEqual([...LEAF_READS, "graph relations.jsonl", ...LEAF_READS]);
  });

  it("G3 reports changed bytes of the same length as tampered, an error on the page and on the relation store", async () => {
    const views = await lintBothViewsFrom(sourcesOver(swapped, []));
    expect(views).toEqual(swapped.onDisk.views);
    expect(healthFindings(views.summary.results)).toEqual(twice(swapped, "artifact-bytes-tampered"));
    const onPage = views.summary.results.find((one) => one.rule === "artifact-bytes-tampered");
    expect(onPage).toMatchObject({
      entityType: "experiments",
      message: `field "result" references ${PINNED} (artifact-bytes-tampered): the artifact bytes no longer match its own manifest`,
    });
  });

  it("G4 reports a missing sidecar as dangling, and still reads the body after the sidecar came back absent", async () => {
    const log: string[] = [];
    const views = await lintBothViewsFrom(sourcesOver(bare, log));
    expect(views).toEqual(bare.onDisk.views);
    expect(healthFindings(views.summary.results)).toEqual(twice(bare, "artifact-dangling"));
    expect(fromFirstResolve(log)).toEqual([...LEAF_READS, "graph relations.jsonl", ...LEAF_READS]);
  });
});

describe("artifact health under the health score, over the same copies", () => {
  it("G5 scores exactly as the disk did, and takes one point for each unhealthy finding", async () => {
    const scored = (project: Minted<OnDisk>): Promise<HealthResult> => evaluateHealthFrom(sourcesOver(project, []));
    const [healthy, tampered, dangling] = [await scored(whole), await scored(swapped), await scored(bare)];
    expect([healthy, tampered, dangling]).toEqual([whole.onDisk.health, swapped.onDisk.health, bare.onDisk.health]);
    expect([scoredRule(healthy, "artifact-bytes-tampered"), scoredRule(healthy, "artifact-dangling")]).toEqual([[], []]);
    expect([scoredRule(tampered, "artifact-bytes-tampered"), scoredRule(dangling, "artifact-dangling")]).toEqual([[[2, "error", 2]], [[2, "error", 2]]]);
    expect([healthy.score - tampered.score, healthy.score - dangling.score]).toEqual([2, 2]);
  });

  it("G6 rejects with a leaf read's own error as the same object, from the coordinator and from the score, and reads nothing after it", async () => {
    const refused = new Error("planted artifact leaf failure");
    const leaves: ArtifactLeafLookup = { get: (rel) => (rel === SIDECAR_LEAF ? refused : whole.copy.files.get(rel)) };
    const log: string[] = [];
    await expect(lintBothViewsFrom(sourcesOver(whole, log, leaves))).rejects.toBe(refused);
    expect(log.slice(-2)).toEqual(LEAF_READS.slice(0, 2));
    await expect(evaluateHealthFrom(sourcesOver(whole, [], leaves))).rejects.toBe(refused);
  });
});
