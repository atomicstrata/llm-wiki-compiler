/**
 * @file test/storage/okf-import-binding.test.ts
 * @description The OKF import intake, WHOLE: `importOkfBundleFrom` (bundle read,
 * index read, block parse, profile load, split, mapping and both collision legs),
 * and `readOkfBundleFrom` / `readIndexFrontmatterFrom` at their limits, with no
 * directory on disk. They exist only after the import was given raw reads of its
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two bundles and three projects are minted on real disk, once.
 * A hand-written bundle (an index whose `x-llmwiki` relations are not a list, a
 * log, a typeless doc, two docs mapping to one slug, and docs colliding with a
 * live page and a pending candidate); a typed bundle EXPORTED by the real
 * `buildOkfBundle` from a newsroom project; a default project holding the live
 * page and a candidate written by the real `writeCandidate`; a newsroom project
 * holding one live desk; and a project whose profile is broken. The real
 * root-taking import answers on disk, as do the limits and refusals. The trees
 * are copied and every minting directory is removed before any case runs. The
 * import's own clock (each mapped page's `createdAt`) is set aside as `<clock>`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The bundle walk with its limits, the confinement
 * check, the index read, the block parse, the profile load, the partition, the
 * mapping, both collision legs with the store's own pending-candidate reader,
 * and every warning and refusal.
 *
 * WHAT THE DOUBLES DECIDE. Only what a copy can: whether a path is held, what a
 * directory lists (a link is listed as neither file nor directory), a held
 * file's text and its UTF-8 byte length. The real path of a held path is the
 * path itself; links are not followed and confinement against a link is shown
 * only on disk (`okf-read-confinement.test.ts`). The profile binding leaf is
 * absent. Every double logs `<step>:<call>`.
 *
 * THE DRY-RUN PREVIEW, WHOLE (P1, P2): `previewOkfImportFrom` over the same
 * intake sources plus the effective profile's sources for the bundle-profile
 * comparison, against the real `runOkfImport(root, dir, { dryRun: true })` on disk.
 *
 * NOT SHOWN HERE: the mutations after an import (staging, trust, recovery,
 * refresh), the MCP tool's own confinement, links, binary files and the disk
 * mechanisms. The doubles are not a hosted store, not an access-control layer
 * and not `ProjectStore`.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { buildOkfBundle } from "../../src/export/okf/bundle.js";
import { importOkfBundle, importOkfBundleFrom, type ImportedOkfBundle, type OkfImportSources } from "../../src/import/okf-import.js";
import { previewOkfImportFrom, runOkfImport, type OkfImportReport } from "../../src/import/run.js";
import { DEFAULT_OKF_LIMITS } from "../../src/import/okf-limits.js";
import { readIndexFrontmatter, readIndexFrontmatterFrom, readOkfBundle, readOkfBundleFrom, type OkfBundleReads } from "../../src/import/okf-read.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../src/utils/constants.js";
import { buildNewsroomProject, installNewsroomProfile, seedNewsroomRelations } from "../fixtures/newsroom-profile.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  effectiveProfileOf, enoent, heldText, mintCopied, mintOnceThenRemove, recordDirsOf, stepsOf, writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "okf-import-binding-";
const MEM_PROJECT = "/memory/project";
const SMALL_INDEX = { ...DEFAULT_OKF_LIMITS, maxDocBytes: 20 };
const doc = (front: string, body: string): string => `---\n${front}\n---\n\n${body}\n`;

/** The import with its one disk-specific value (where the profile was loaded from) set aside. */
type Imported = Omit<ImportedOkfBundle, "profile"> & { profile?: { profileId: string; digest: string } };
/** What the disk answered for one project. */
interface OnDisk { imported?: Imported; warnings: string[]; refusals: Record<string, string>; index?: { meta: Record<string, unknown>; warnings: string[] }; preview?: OkfImportReport }

const tracker = tempRootTracker();
let bundle: Minted<null>;
let typedBundle: Minted<null>;
let wiki: Minted<OnDisk>;
let newsroom: Minted<OnDisk>;
let broken: Minted<OnDisk>;

const message = (run: Promise<unknown>, at: string): Promise<string> => run.then(() => "resolved", (error: Error) => error.message.split(at).join("<bundle>"));
const quiet = (): void => {};
/** The run's own clock (an imported page's `createdAt`), set aside on both sides. */
const CLOCK = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const settled = (imported: ImportedOkfBundle): Imported => JSON.parse(JSON.stringify(
  { ...imported, profile: imported.profile && { profileId: imported.profile.profile.profileId, digest: imported.profile.digest } }).replace(CLOCK, "<clock>")) as Imported;

/** The hand-written bundle. */
function seedBundle(dir: string): Promise<void> {
  return writeFiles(dir, {
    "index.md": doc('okf_version: "0.1"\nx-llmwiki:\n  relations: not-a-list', "# Index"), "log.md": "# Log\n",
    "concepts/alpha.md": doc("type: concept\ntitle: Alpha", "Alpha first."), "queries/alpha.md": doc("type: concept\ntitle: Alpha Again", "Same slug."),
    "concepts/taken.md": doc("type: concept\ntitle: Taken", "Collides with a live page."),
    "concepts/pending.md": doc("type: concept\ntitle: Pending", "Collides with a candidate."), "notype.md": doc("title: No type", "Skipped."),
  });
}

/** A typed bundle exported by the real writer from a newsroom project. */
async function seedTypedBundle(dir: string): Promise<void> {
  const exporter = await tracker.create(PREFIX);
  await buildNewsroomProject(exporter);
  await seedNewsroomRelations(exporter);
  await buildOkfBundle(exporter, [], dir, quiet);
}

/** The real import on disk, then the limits and refusals. */
async function askedOnDisk(root: string, from: string, withLimits: boolean): Promise<OnDisk> {
  const warnings: string[] = [];
  const imported = settled(await importOkfBundle(from, root, {}, (m) => warnings.push(m)));
  const preview = await runOkfImport(root, from, { dryRun: true });
  if (!withLimits) return { imported, warnings, refusals: {}, preview };
  const indexWarnings: string[] = [];
  const meta = await readIndexFrontmatter(from, SMALL_INDEX, (m) => indexWarnings.push(m));
  const refusals = {
    maxFiles: await message(importOkfBundle(from, root, { maxFiles: 2 }, quiet), from),
    docBytes: await message(readOkfBundle(from, { maxDocBytes: 40 }, quiet), from),
    missing: await message(readOkfBundle(path.join(from, "absent"), {}, quiet), from),
  };
  return { imported, warnings, refusals, index: { meta, warnings: indexWarnings }, preview };
}

mintOnceThenRemove(tracker, async () => {
  bundle = await mintCopied(tracker, PREFIX, seedBundle, async () => null);
  typedBundle = await mintCopied(tracker, PREFIX, seedTypedBundle, async () => null);
  wiki = await mintCopied(tracker, PREFIX, async (root) => {
    await writeFiles(root, { "wiki/concepts/taken.md": doc("title: Taken", "Live.") });
    await writeCandidate(root, { title: "Pending", slug: "pending", summary: "", sources: [], body: doc("title: Pending", "Staged.") });
  }, (root) => askedOnDisk(root, bundle.dir, true));
  newsroom = await mintCopied(tracker, PREFIX, async (root) => {
    await installNewsroomProfile(root);
    await writeFiles(root, { "wiki/desks/metro.md": doc("name: Metro Desk\nstage: active", "Live desk.") });
  }, (root) => askedOnDisk(root, typedBundle.dir, false));
  broken = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, { [PROFILE_FILE]: "{" }),
    async (root) => ({ warnings: [], refusals: { profile: (await message(importOkfBundle(bundle.dir, root, {}, quiet), bundle.dir)).split(root).join("<root>") } }));
});

/** The raw bundle reads over a copied bundle held at `base`. */
function bundleReadsOf(copy: Copy, base: string, note: Note): OkfBundleReads {
  const rel = (location: string): string => path.posix.relative(base, location);
  return {
    realpath: async (location) => { note(`realpath ${rel(location)}`); return rel(location) === "" || copy.files.has(rel(location)) || copy.listings.has(rel(location)) ? location : null; },
    listEntries: async (dir) => {
      note(`list ${rel(dir)}`);
      const entries = copy.listings.get(rel(dir));
      if (entries === undefined) throw enoent();
      return entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.kind === "directory", isFile: () => entry.kind === "file" }));
    },
    byteSize: async (location) => { note(`size ${rel(location)}`); return Buffer.byteLength(heldText(copy, rel(location)), "utf8"); },
    readText: async (location) => { note(`read ${rel(location)}`); return heldText(copy, rel(location)); },
  };
}

/** Where a copied bundle is held in memory: the same directory name, so the bundle id is the same. */
const memoryBase = (minted: Minted<null>): string => `/memory/${path.basename(minted.dir)}`;

/** The import sources over one project copy and one bundle copy, each read logged as `<step>:<call>`. */
function importSourcesOf(project: Copy, source: Minted<null>, log: string[]): OkfImportSources {
  const as = (step: string): Note => (call) => { log.push(`${step}:${call}`); };
  const live = as("live");
  return {
    bundle: bundleReadsOf(source.copy, memoryBase(source), as("bundle")),
    profile: effectiveProfileOf(project, as("profile")),
    collisions: {
      candidates: recordDirsOf(project, as("candidates")),
      accessible: async (location) => {
        live(location);
        const rel = path.posix.relative(MEM_PROJECT, location);
        if (!project.files.has(rel) && !project.listings.has(rel)) throw enoent();
      },
    },
  };
}

/** The whole import in memory over one project and one bundle. */
async function importedInMemory(project: Minted<OnDisk>, source: Minted<null>) {
  const log: string[] = [];
  const warnings: string[] = [];
  const imported = settled(await importOkfBundleFrom(importSourcesOf(project.copy, source, log), memoryBase(source), MEM_PROJECT, {}, (m) => warnings.push(m)));
  return { imported, warnings, log };
}

/** The whole dry-run preview in memory: the intake's sources, then the profile's again under `sections`. */
async function previewInMemory(project: Minted<OnDisk>, source: Minted<null>) {
  const log: string[] = [];
  const sections: Note = (call) => { log.push(`sections:${call}`); };
  const sources = { import: importSourcesOf(project.copy, source, log), profile: effectiveProfileOf(project.copy, sections) };
  return { report: await previewOkfImportFrom(sources, MEM_PROJECT, memoryBase(source)), log };
}

describe("the OKF import intake over copied bundles and projects, with every directory gone", () => {
  it("I1 runs after every minting directory was removed, on project copies holding no binding leaf", () => {
    for (const one of [bundle, typedBundle, wiki, newsroom, broken]) expectMintingDirectoryRemoved(one.dir, PREFIX);
    expect([wiki, newsroom, broken].map((one) => one.copy.files.has(`${LLMWIKI_DIR}/active-product.json`))).toEqual([false, false, false]);
  });

  it("I2 imports the hand-written bundle into the default project exactly as the disk did: skips, warnings, two candidate reads", async () => {
    const { imported, warnings, log } = await importedInMemory(wiki, bundle);
    expect([imported, warnings]).toEqual([wiki.onDisk.imported, wiki.onDisk.warnings]);
    expect(imported.skipped.map((skip) => [skip.okfPath, skip.reason])).toEqual([
      ["concepts/pending.md", "pending-candidate"], ["concepts/taken.md", "live-page"], ["queries/alpha.md", "duplicate-in-bundle"],
    ]);
    expect(warnings).toEqual(["OKF import: skipped doc without a valid type: notype.md", "OKF import: bundle relation is not a list; ignored"]);
    expect(stepsOf(log)).toEqual(["bundle", "profile", "candidates", "live", "candidates"]);
  });

  it("I3 imports the exported newsroom bundle into the typed project exactly as the disk did, skipping the live desk", async () => {
    const { imported, warnings } = await importedInMemory(newsroom, typedBundle);
    expect([imported, warnings]).toEqual([newsroom.onDisk.imported, newsroom.onDisk.warnings]);
    expect(imported.typedSkipped.map((skip) => [skip.entityType, skip.slug, skip.reason])).toEqual([["desks", "metro", "live-page"]]);
    expect([imported.profile?.profileId, imported.typed.map((t) => t.entityType).sort()]).toEqual(["newsroom", ["articles", "bylines"]]);
  });

  it("I4 applies the bundle limits, the index size bound and the not-found refusal with the disk's messages", async () => {
    const base = memoryBase(bundle);
    const reads = bundleReadsOf(bundle.copy, base, () => {});
    const sources = importSourcesOf(wiki.copy, bundle, []);
    const refusals = {
      maxFiles: await message(importOkfBundleFrom(sources, base, MEM_PROJECT, { maxFiles: 2 }, quiet), base),
      docBytes: await message(readOkfBundleFrom(reads, base, { maxDocBytes: 40 }, quiet), base),
      missing: await message(readOkfBundleFrom(reads, path.posix.join(base, "absent"), {}, quiet), base),
    };
    const indexWarnings: string[] = [];
    const meta = await readIndexFrontmatterFrom(reads, base, SMALL_INDEX, (m) => indexWarnings.push(m));
    expect([refusals, { meta, warnings: indexWarnings }]).toEqual([wiki.onDisk.refusals, wiki.onDisk.index]);
  });

  it("I5 refuses a broken profile with the disk's message (its root label set aside), after the bundle reads and before any collision read", async () => {
    const log: string[] = [];
    const run = importOkfBundleFrom(importSourcesOf(broken.copy, bundle, log), memoryBase(bundle), MEM_PROJECT, {}, quiet);
    expect((await message(run, memoryBase(bundle))).split("memory:project").join("<root>")).toBe(broken.onDisk.refusals.profile);
    expect(stepsOf(log)).toEqual(["bundle", "profile"]);
  });

  it("P1 previews the hand-written bundle into the default project exactly as the disk's dry run did, with no second profile read", async () => {
    const { report, log } = await previewInMemory(wiki, bundle);
    expect(report).toEqual(wiki.onDisk.preview);
    expect([report.mode, report.relationOutcomes, report.bundleProfile]).toEqual(["dry-run", undefined, undefined]);
    expect(stepsOf(log)).toEqual(["bundle", "profile", "candidates", "live", "candidates"]);
  });

  it("P2 previews the newsroom bundle exactly as the disk's dry run did: inert relations, the profile compared on a second read", async () => {
    const { report, log } = await previewInMemory(newsroom, typedBundle);
    expect(report).toEqual(newsroom.onDisk.preview);
    expect(report.bundleProfile?.mismatch.differingProfileContentHash).toBeUndefined();
    expect(new Set(report.relationOutcomes?.map((outcome) => outcome.outcome))).toEqual(new Set(["skipped-dry-run"]));
    expect(stepsOf(log).at(-1)).toBe("sections");
  });
});
