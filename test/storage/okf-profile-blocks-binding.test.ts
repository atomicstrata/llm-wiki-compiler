/**
 * @file test/storage/okf-profile-blocks-binding.test.ts
 * @description The OKF bundle's two profile-aware readers, WHOLE, with no
 * project directory: `collectProfileEntityDocsFrom` (the entity documents) and
 * `collectBundleBlockFrom` (the `index.md` `x-llmwiki` block). Both exist only
 * after the readers were given raw reads of their own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once: an empty
 * directory (the built-in default profile); the newsroom fixture with its
 * articles typed `NewsArticle` through the `export.okfType` hook and its one
 * relation written by the real relation writer; and the workflow fixture,
 * where the real `startWorkflow` writes one signed run and a copy of that run
 * under another id is planted beside it. For each, the real root-taking
 * readers answer on disk with the profile loaded once by the real loader, the
 * tree is copied, and the directories are removed before any case runs.
 *
 * THE KEY. The real `startWorkflow` writes this throwaway project's
 * `.llmwiki/workflows/.runkey`, and the generic tree copy DOES read it, like
 * every regular file. That entry is DISCARDED from the copied fixture right
 * after minting, before any case runs; K1 checks it is gone. No double serves
 * the key and no case reads it. The run integrity computation (a closure over
 * the key, not its text) is retained from the disk binding's `loadIntegrity`,
 * taken ONCE while the project exists. Discarding the map entry is not a
 * secure erasure, and the key was read once by the copy.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The profile load over the copied profile text,
 * the entity collection with its validation, the OKF rendering, both sorts,
 * the live-valid relation read with the store's checksum rules, the run
 * listing, and each run read with its parse and HMAC check. No answer is
 * replayed or written by hand.
 *
 * WHAT THE DOUBLES DECIDE. Only what a copy can: whether a path is held, what
 * a directory lists, and a held file's text; plus the held integrity
 * computation. Every double logs `<step>:<call>`.
 *
 * NOT SHOWN HERE: anything the local disk decides (confinement, links, size
 * caps), a legacy-unsigned or migrated run, a product binding, and the bundle
 * writes, reference selection and title (`buildOkfBundle`, `runOkfExport`).
 * `okf-profile-export.test.ts` and the workflow tests show those on disk.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { collectBundleBlock, collectBundleBlockFrom, type BundleBlock } from "../../src/export/okf/bundle-block.js";
import { collectProfileEntityDocs, collectProfileEntityDocsFrom, type ProfileEntityDoc } from "../../src/export/okf/profile-docs.js";
import type { LinkResolver } from "../../src/export/okf/types.js";
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../../src/profile/block.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../src/utils/constants.js";
import type { RunIntegrityComputation } from "../../src/workflow-history/integrity.js";
import { diskWorkflowRunReads, type WorkflowRunReads } from "../../src/workflow-history/store.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { buildNewsroomProject, NEWSROOM_PROFILE, seedNewsroomRelations } from "../fixtures/newsroom-profile.js";
import { installWorkflowProfile } from "../fixtures/workflow-profile.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  effectiveProfileOf, entityScansOf, mintCopied, mintOnceThenRemove, stepsOf, type Copy, type Minted, type Note,
} from "./copied-project.js";
import { graphStoreOf } from "./export-profile-doubles.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "okf-profile-blocks-";
const REAL_ROOT = "/memory/real/root";
const RUNS_REL = `${LLMWIKI_DIR}/workflows/runs`;
const FORGED_ID = "forged-run";
/** The throwaway workflow key the real writer creates; the copy drops it before any case. */
const RUN_KEY_REL = `${LLMWIKI_DIR}/workflows/.runkey`;
/** Every entity-to-entity wikilink the docs could rewrite resolves to nothing here; the resolver is pure. */
const RESOLVE: LinkResolver = () => null;

/** What the disk answered for one project, and the integrity computation the run store vouched with. */
interface OnDisk { docs: ProfileEntityDoc[]; block: BundleBlock | undefined; integrity: RunIntegrityComputation | null }

const tracker = tempRootTracker();
let plain: Minted<OnDisk>;
let newsroom: Minted<OnDisk>;
let workflow: Minted<OnDisk>;

/** Ask the real root-taking readers, with the profile loaded ONCE by the real loader. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const loaded = await loadNonDefaultProfile(root);
  return {
    docs: await collectProfileEntityDocs(root, RESOLVE, loaded), block: await collectBundleBlock(root, loaded),
    integrity: await diskWorkflowRunReads(root).loadIntegrity(),
  };
}

/** The newsroom fixture, with articles typed through the `export.okfType` hook, and its one relation. */
async function seedNewsroom(root: string): Promise<void> {
  await buildNewsroomProject(root);
  const { entities } = NEWSROOM_PROFILE;
  const typedArticles = { ...entities.articles, export: { okfType: "NewsArticle" } };
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify({ ...NEWSROOM_PROFILE, entities: { ...entities, articles: typedArticles } }), "utf8");
  await seedNewsroomRelations(root);
}

/** The workflow fixture with one signed run, and that run's text planted under another id. */
async function seedWorkflow(root: string): Promise<void> {
  await installWorkflowProfile(root);
  const { runId } = await startWorkflow(root, "build", {});
  const raw = await readFile(path.join(root, RUNS_REL, `${runId}.json`), "utf8");
  await writeFile(path.join(root, RUNS_REL, `${FORGED_ID}.json`), raw.replace(JSON.stringify(runId), JSON.stringify(FORGED_ID)), "utf8");
}

mintOnceThenRemove(tracker, async () => {
  plain = await mintCopied(tracker, PREFIX, async () => {}, askedOnDisk);
  newsroom = await mintCopied(tracker, PREFIX, seedNewsroom, askedOnDisk);
  workflow = await mintCopied(tracker, PREFIX, seedWorkflow, askedOnDisk);
  workflow.copy.files.delete(RUN_KEY_REL);
});

/** The run reads over the copy: the private and runs directories when the copy lists them, their listing, a held leaf's text, and the held computation. */
function runsOf(copy: Copy, integrity: RunIntegrityComputation | null, note: Note): WorkflowRunReads {
  return {
    resolvePrivateDir: async () => { note("private"); return copy.listings.has(LLMWIKI_DIR) ? LLMWIKI_DIR : null; },
    resolveRunsDir: async (privateDir) => {
      note(`dir ${privateDir}`);
      return copy.listings.has(`${privateDir}/workflows/runs`) ? { kind: "ok", dir: `${privateDir}/workflows/runs` } : { kind: "absent" };
    },
    listRunNames: async (runsDir) => { note(`list ${runsDir}`); return copy.listings.get(runsDir)!.map((entry) => entry.name); },
    readRunLeaf: async (runsDir, name) => {
      note(`leaf ${name}`);
      const body = copy.files.get(`${runsDir}/${name}`);
      return body === undefined ? { kind: "absent" } : { kind: "ok", body };
    },
    loadIntegrity: async () => { note("integrity"); return integrity; },
  };
}

/** Both readers over one copy, with the profile loaded ONCE by the real loader over the copied profile text. */
async function readOver(project: Minted<OnDisk>): Promise<{ docs: ProfileEntityDoc[]; block: BundleBlock | undefined; log: string[] }> {
  const log: string[] = [];
  const as = (step: string): Note => (call) => { log.push(`${step}:${call}`); };
  const loaded: LoadedProfile | undefined = await loadNonDefaultProfileFrom(effectiveProfileOf(project.copy, as("profile")));
  const docs = await collectProfileEntityDocsFrom(entityScansOf(project.copy, REAL_ROOT, as("scans")), RESOLVE, loaded);
  const sources = { graph: graphStoreOf(project.copy, as("graph")), runs: runsOf(project.copy, project.onDisk.integrity, as("runs")) };
  return { docs, block: await collectBundleBlockFrom(sources, loaded), log };
}

describe("the OKF profile readers over copied projects, with the directories gone", () => {
  it("K1 runs after every minting directory was removed; only the typed copies hold a profile, and none a binding leaf or a run key", () => {
    const all = [plain, newsroom, workflow];
    for (const one of all) expectMintingDirectoryRemoved(one.dir, PREFIX);
    expect(all.map((one) => one.copy.files.has(PROFILE_FILE))).toEqual([false, true, true]);
    expect(all.map((one) => one.copy.files.has(`${LLMWIKI_DIR}/active-product.json`))).toEqual([false, false, false]);
    expect(all.map((one) => one.copy.files.has(RUN_KEY_REL))).toEqual([false, false, false]);
  });

  it("K2 omits both for the built-in default, as the disk did, and asks nothing after the profile", async () => {
    const { docs, block, log } = await readOver(plain);
    expect([docs, block, plain.onDisk.docs, plain.onDisk.block]).toEqual([[], undefined, [], undefined]);
    expect(stepsOf(log)).toEqual(["profile"]);
  });

  it("K3 renders the newsroom documents exactly as the disk did: hook type, lifecycle, literal title only, sorted", async () => {
    const { docs } = await readOver(newsroom);
    expect(docs).toEqual(newsroom.onDisk.docs);
    expect(docs.map((doc) => [doc.rel, doc.title])).toEqual([
      ["articles/port-strike-latest.md", "Port Strike Enters Second Week"], ["bylines/j-rivera.md", "J. Rivera"], ["desks/metro.md", "Metro Desk"],
    ]);
    const article = docs[0]!.content;
    expect([article.includes("type: NewsArticle"), article.includes("state: published"), /^title:/m.test(article)]).toEqual([true, true, false]);
  });

  it("K4 builds the newsroom block exactly as the disk did: identity, the one relation, no runs", async () => {
    const { block, log } = await readOver(newsroom);
    expect(block).toEqual(newsroom.onDisk.block);
    expect([block?.profile.profileId, block?.profile.profileVersion, block?.relations.map((entry) => [entry.type, entry.from, entry.to])]).toEqual(
      ["newsroom", "0.1.0", [["filed-under", "articles/port-strike-latest", "desks/metro"]]]);
    expect([block?.workflows, stepsOf(log)]).toEqual([[], ["profile", "scans", "graph", "runs"]]);
  });

  it("K5 summarises the one signed run as the disk did, and refuses the planted copy under another id", async () => {
    const { block, log } = await readOver(workflow);
    expect(block).toEqual(workflow.onDisk.block);
    expect(block?.workflows.map((entry) => [entry.workflowId, entry.runId === FORGED_ID])).toEqual([["build", false]]);
    expect(log.filter((call) => call.startsWith("runs:leaf")).sort()).toEqual(
      [`runs:leaf ${FORGED_ID}.json`, `runs:leaf ${block?.workflows[0]?.runId}.json`].sort());
  });
});
