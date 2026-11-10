/**
 * @file test/storage/export-json-binding.test.ts
 * @description The read-only export pipeline, `collectExportPagesFrom` and the
 * WHOLE in-memory JSON export `exportJsonFrom`, with no project directory. Both
 * exist only after the export was given sources to read through, so this file
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a compiled wiki
 * with the built-in default profile (a fresh, a stale, a computed-orphaned, a
 * frontmatter-orphaned and an untitled concept, a saved query, a non-page
 * file, a state record and its sources), and a typed project with a legacy
 * custom profile and one gated page that misses its relation. For each, the
 * real `collectExportPages(root)` and `exportJson(root, …)` answer on disk,
 * the tree is copied into memory, and the directories are removed before any
 * case runs. Each case then runs the production body over that copy and
 * requires the answer the disk gave; only `exportedAt`, the run's own clock,
 * is set aside.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Both bodies and, under them, the REAL lower
 * bodies: the raw page collection, the classified state read, the freshness
 * snapshot with its source hashing, the export filters, decoration and sort,
 * the export profile block, the journal warning mapping, and the document with
 * its `projectId` validation and option sanitisation. No answer is replayed or
 * written by hand.
 *
 * WHAT THE DOUBLES DECIDE. Only what a copy can: whether a path is held, what
 * a directory lists, and a held file's text. A source is located only when the
 * copy holds it as a FILE. The profile binding leaf and the journal are
 * answered `absent`, and the first case shows the copies hold neither. The
 * preparation store is never asked. Every double logs `<step>:<call>`; the
 * page scans log under `content`.
 *
 * NOT SHOWN HERE: anything the local disk decides (confinement, links, size
 * caps, no-follow opens), a journal that exists, `runExport` (file writes, the
 * OKF bundle and the project title) and the other export formats.
 * `export.test.ts`, `export/export-json.test.ts`, `export-freshness.test.ts`
 * and `journal-health-surfaces.test.ts` show those on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { exportJson, exportJsonFrom, type ExportJsonSources } from "../../src/commands/export.js";
import { collectExportPages, collectExportPagesFrom } from "../../src/export/collect.js";
import type { ExportJsonOptions, JsonExportDocument } from "../../src/export/json-export.js";
import type { ExportPage } from "../../src/export/types.js";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR, STATE_FILE } from "../../src/utils/constants.js";
import { genericGatedProfile, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  absentJournalOf, entityScansOf, expectRemovedDefaultCopies, expectRemovedLegacyProfileCopies, mintCopied, mintOnceThenRemove,
  recordsOf, sourceFreshnessOf, stepsOf, writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";
import { exportProfileSourcesOf } from "./export-profile-doubles.js";

const PREFIX = "export-json-";
const REAL_ROOT = "/memory/real/root";
const PROJECT_ID = "export-binding";
const KEPT = "The kept source.\n";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const markdown = (front: string[], body = "Body.\n"): string => `---\n${front.join("\n")}\n---\n\n${body}`;

/** What the disk answered for one project: the pages, the document with its clock set aside, and the rejection of an invalid `projectId`. */
interface OnDisk { pages: ExportPage[]; doc: Omit<JsonExportDocument, "exportedAt">; invalid: unknown }
const INVALID_ID = "Not Valid";

const tracker = tempRootTracker();
let compiled: Minted<OnDisk>;
let typed: Minted<OnDisk>;

/** The document without the run's own clock, which it must still carry as an ISO instant. */
function withoutClock(doc: JsonExportDocument): Omit<JsonExportDocument, "exportedAt"> {
  const { exportedAt, ...rest } = doc;
  expect(new Date(exportedAt).toISOString()).toBe(exportedAt);
  return rest;
}

/** Ask the real root-taking pipeline. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const doc = withoutClock(await exportJson(root, { projectId: PROJECT_ID }));
  return { pages: await collectExportPages(root), doc, invalid: await exportJson(root, { projectId: INVALID_ID }).catch((error: unknown) => error) };
}

/** Three recorded sources: one unchanged, one changed since compile, one deleted. */
function compiledState(): string {
  const sources = {
    "kept.md": { hash: digest(KEPT), concepts: ["alpha"], compiledAt: "2026-02-01T00:00:00.000Z" },
    "changed.md": { hash: "recorded-before-change", concepts: ["beta"], compiledAt: "2026-02-02T00:00:00.000Z" },
    "deleted.md": { hash: "recorded-before-delete", concepts: ["gamma"], compiledAt: "2026-02-03T00:00:00.000Z" },
  };
  return JSON.stringify({ version: 1, indexHash: "", sources });
}

/** The compiled wiki: every page shape the export filters or decorates differently. */
function seedCompiled(root: string): Promise<void> {
  const concept = (slug: string): string => `${CONCEPTS_DIR}/${slug}.md`;
  return writeFiles(root, {
    [STATE_FILE]: compiledState(), [`${SOURCES_DIR}/kept.md`]: KEPT, [`${SOURCES_DIR}/changed.md`]: "Edited after compile.\n",
    [concept("alpha")]: markdown(
      ["title: Alpha", "summary: The first.", "sources: [kept.md]", "tags: [core]", "aliases: [A]", "provenanceState: extracted",
        "confidence: 0.8", 'createdAt: "2026-02-01T00:00:00.000Z"', 'updatedAt: "2026-02-04T00:00:00.000Z"'],
      "Alpha links [[Beta]] and claims a fact ^[kept.md].\n"),
    [concept("beta")]: markdown(["title: Beta", "sources: [changed.md]", "contradictedBy:", "  - slug: alpha", "    reason: disagrees"]),
    [concept("gamma")]: markdown(["title: Gamma", "sources: [deleted.md]"]),
    [concept("flagged")]: markdown(["title: Flagged", "orphaned: true"]),
    [concept("untitled")]: markdown(["summary: No title."]),
    [`${CONCEPTS_DIR}/notes.txt`]: "Not a page.\n",
    [`${QUERIES_DIR}/saved.md`]: markdown(["title: Saved", 'createdAt: "2026-03-01T00:00:00.000Z"']),
  });
}

/** A legacy custom profile whose one `alpha` page is sealed without the `bonds` relation it needs; no wiki, no state. */
async function seedTyped(root: string): Promise<void> {
  await writeProfileFile(root, genericGatedProfile());
  await writeFiles(root, { "wiki/beta/b1.md": markdown(["title: Beta One"]), "wiki/alpha/a1.md": markdown(["title: Alpha One", "mode: sealed"]) });
}

mintOnceThenRemove(tracker, async () => {
  compiled = await mintCopied(tracker, PREFIX, seedCompiled, askedOnDisk);
  typed = await mintCopied(tracker, PREFIX, seedTyped, askedOnDisk);
});

/** The JSON export's sources over one copy, each logging `<step>:<call>`. */
function sourcesOf(copy: Copy, log: string[]): ExportJsonSources {
  const as = (step: string): Note => (call) => { log.push(`${step}:${call}`); };
  return {
    pages: { scans: entityScansOf(copy, REAL_ROOT, as("content")), records: recordsOf(copy, as("state")), freshness: sourceFreshnessOf(copy, as("freshness")) },
    profile: exportProfileSourcesOf(copy, REAL_ROOT, log),
    journal: absentJournalOf(as("journal")),
  };
}

/** The whole JSON export over one copy, with its ordered log. */
async function exportedFrom(copy: Copy, options: ExportJsonOptions): Promise<{ doc: JsonExportDocument; log: string[] }> {
  const log: string[] = [];
  return { doc: await exportJsonFrom(sourcesOf(copy, log), options), log };
}

describe("the read-only export pipeline over copied projects, with the directories gone", () => {
  it("J1 runs after every minting directory was removed, on copies holding no journal and no binding leaf", () => {
    expectRemovedDefaultCopies([compiled], PREFIX);
    expectRemovedLegacyProfileCopies([typed], PREFIX);
  });

  it("J2 collects the compiled wiki's pages exactly as the disk did: filters, freshness, source hashes, timestamps", async () => {
    const log: string[] = [];
    const pages = await collectExportPagesFrom(sourcesOf(compiled.copy, log).pages);
    expect(pages).toEqual(compiled.onDisk.pages);
    expect(pages.map((page) => [page.title, page.freshnessStatus, page.sourceHashes])).toEqual([
      ["Alpha", "fresh", [digest(KEPT)]], ["Beta", "stale", ["recorded-before-change"]], ["Saved", "unverified", []],
    ]);
    expect(pages.map((page) => [page.createdAt, page.updatedAt])).toEqual([
      ["2026-02-01T00:00:00.000Z", "2026-02-04T00:00:00.000Z"], [undefined, undefined], ["2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ]);
    expect(stepsOf(log)).toEqual(["content", "state", "freshness"]);
    expect(log.filter((call) => call.startsWith("freshness:resolve"))).toEqual(
      ["freshness:resolve kept.md", "freshness:resolve changed.md", "freshness:resolve deleted.md"]);
  });

  it("J3 answers the compiled wiki's JSON document as the disk did, and ignores forged profile and warnings options", async () => {
    const forged = { projectId: PROJECT_ID, profile: { forged: true }, warnings: [{ code: "forged" }] } as ExportJsonOptions;
    const { doc, log } = await exportedFrom(compiled.copy, forged);
    expect(withoutClock(doc)).toEqual(compiled.onDisk.doc);
    expect(["profile" in doc, "warnings" in doc, doc.projectId, doc.pageCount]).toEqual([false, false, PROJECT_ID, 3]);
    expect(stepsOf(log)).toEqual(["content", "state", "freshness", "profile", "journal"]);
  });

  it("J4 answers the typed project's JSON document as the disk did: no pages, no source read, the profile block's standing problem", async () => {
    const { doc, log } = await exportedFrom(typed.copy, { projectId: PROJECT_ID });
    expect(withoutClock(doc)).toEqual(typed.onDisk.doc);
    expect([doc.pageCount, doc.profile?.profileId, doc.profile?.problems?.map((problem) => problem.kind)]).toEqual(
      [0, "generic-gated", ["lifecycle-relation-requirement-unmet"]]);
    expect(stepsOf(log)).toEqual(["content", "state", "profile", "scans", "real", "graph", "scans", "graph", "journal"]);
  });

  it("J5 validates the projectId last, after every read, and rejects with the disk's error", async () => {
    const log: string[] = [];
    const rejected = await exportJsonFrom(sourcesOf(compiled.copy, log), { projectId: INVALID_ID }).catch((error: unknown) => error);
    expect([rejected instanceof Error, compiled.onDisk.invalid instanceof Error]).toEqual([true, true]);
    expect((rejected as Error).message).toBe((compiled.onDisk.invalid as Error).message);
    expect(stepsOf(log)).toEqual(["content", "state", "freshness", "profile", "journal"]);
  });
});
