/**
 * @file test/storage/profile-lint-binding.test.ts
 * @description Three lint consumers as WHOLE bodies with no project directory:
 * the non-default profile's lint evaluation (`collectProfileLintInputFrom` and
 * `collectProfileLintFindings`), `checkJournalHealthFrom` and
 * `checkPendingEmbeddingsFrom`. The source-taking forms exist only after these
 * were given sources of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: a legacy custom
 * profile, notes that trip each page-derived profile finding, and both
 * embedding markers written by the real `writePendingEmbeddings`. The
 * root-taking forms are asked on that disk, the tree is copied into memory,
 * and the directory is removed before any case runs. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Profile lint: the real entity collection, the
 * problem mapping, the page content checks, then the real relation, standing,
 * event and artifact checks in that order, each through the seam it already
 * had. The two health rules: the real warning mappers and marker parsing. The
 * inputs are raw page texts, raw listings and raw marker texts. No finding and
 * no entity page is copied in. The profile is a VALUE the caller passes on
 * disk too; the same value is passed here.
 *
 * WHAT THIS PROJECT REACHES, AND NO MORE. It has no relation store, no event
 * store, no journal, no gated lifecycle and no declared artifact. So in memory
 * the relation and event checks each read an ABSENT store, the standing check
 * reads nothing, and the artifact questions are never asked. F4 makes a store
 * read reject, to show the fail-closed mapping and the pass-through of an
 * error that is not a store error. Relation records, event chains, dangling
 * endpoints, standing violations and artifact health are NOT exercised here;
 * their own disk suites cover them.
 *
 * NOT CLOSED BY THIS FILE: the lint coordinator, which still takes a root, and
 * the workflow-run health rule. The doubles are not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { EventReadSources } from "../../src/events/store-read.js";
import { checkJournalHealth, checkJournalHealthFrom } from "../../src/linter/journal-rule.js";
import { checkPendingEmbeddings, checkPendingEmbeddingsFrom } from "../../src/linter/pending-embeddings-rule.js";
import type { LintResult } from "../../src/linter/types.js";
import {
  collectProfileLintFindings, collectProfileLintInput, collectProfileLintInputFrom, lintProfileEntities,
  type ProfileLintCollection, type ProfileLintSources,
} from "../../src/profile/lint.js";
import { JOURNAL_UNAVAILABLE_CODE } from "../../src/trust/journal-health-warning.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, PROFILE_FILE, QUARANTINED_EMBEDDINGS_FILE, WIKI_GRAPH_DIR } from "../../src/utils/constants.js";
import type { GraphStoreReads } from "../../src/utils/jsonl-store.js";
import { writePendingEmbeddings, type EmbeddingMarkerReads } from "../../src/utils/pending-embeddings.js";
import { SAMPLE_PROFILE } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  absentJournalOf, entityScansOf, expectRemovedLegacyProfileCopies, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Minted,
} from "./copied-project.js";
import { unaskedPreparationStore } from "./preparation-store-doubles.js";

const PREFIX = "profile-lint-";
const NOTES = "wiki/notes";
const note = (front: string, body: string): string => `---\n${front}\n---\n\n${body}\n`;

/** What the root-taking forms answered on the real disk, and the project's real path, which typed page paths are reported under. */
interface OnDisk { real: string; profileLint: ProfileLintCollection; entities: LintResult[]; journal: LintResult[]; embeddings: LintResult[] }
const tracker = tempRootTracker();
let project: Minted<OnDisk>;

/** One embedding awaiting refresh and one stopped after the last allowed attempt, each in its own marker file. */
const MARKED = [
  { file: PENDING_EMBEDDINGS_FILE, pageId: "notes/short", attempts: 0 },
  { file: QUARANTINED_EMBEDDINGS_FILE, pageId: "notes/cited", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
] as const;

/**
 * A `SAMPLE_PROFILE` project (`notes` requires a `title`): a titled note with
 * almost no body, a titled note with a malformed citation, a note with no
 * title, a file whose name is not slug-safe, a note declaring another slug, a
 * file that is not a page; then one pending and one quarantined embedding.
 */
async function seed(root: string): Promise<void> {
  await writeFiles(root, {
    [PROFILE_FILE]: JSON.stringify(SAMPLE_PROFILE),
    [`${NOTES}/short.md`]: note("title: Short", "Tiny."),
    [`${NOTES}/cited.md`]: note("title: Cited", "A body long enough to count as prose, with a citation that does not parse. ^[a.md:abc]"),
    [`${NOTES}/untitled.md`]: note("slug: untitled", "Untitled note."),
    [`${NOTES}/Bad_Name.md`]: note("title: Bad name", "Not slug-safe."),
    [`${NOTES}/renamed.md`]: note("title: Renamed\nslug: other", "Declares another slug."),
    [`${NOTES}/README.txt`]: "Not a page.\n",
  });
  for (const { file, pageId, attempts } of MARKED) await writePendingEmbeddings(root, [{ pageId, attempts }], file);
}

/** Every root-taking form asked on the real disk. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  return {
    real: await realpath(root),
    profileLint: await collectProfileLintFindings(await collectProfileLintInput(root, SAMPLE_PROFILE)),
    entities: await lintProfileEntities(root, SAMPLE_PROFILE),
    journal: await checkJournalHealth(root), embeddings: await checkPendingEmbeddings(root),
  };
}

mintOnceThenRemove(tracker, async () => { project = await mintCopied(tracker, PREFIX, seed, askedOnDisk); });

/** The graph-store read over the copy: a held store file's raw text, or `null`. With `refusal`, each read rejects with what it builds from the store's own error factory. */
function graphOver(log: string[], refusal?: (config: Parameters<GraphStoreReads["readStore"]>[0]) => Error): GraphStoreReads {
  return { readStore: async (config) => {
    log.push(`graph ${config.fileName}`);
    if (refusal) throw refusal(config);
    return project.copy.files.get(`${WIKI_GRAPH_DIR}/${config.fileName}`) ?? null;
  } };
}

/** The event store's sources over the copy: the graph read; a private directory when the copy lists one; a head leaf's raw text when held. */
function eventsOver(graph: GraphStoreReads, log: string[]): EventReadSources {
  const privateDir = path.dirname(PROFILE_FILE);
  return {
    graph,
    resolvePrivateDir: async () => { log.push("events.private"); return project.copy.listings.has(privateDir) ? privateDir : null; },
    readHeadLeaf: async (dir, name) => {
      log.push(`events.head ${name}`);
      const text = project.copy.files.get(`${dir}/${name}`);
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },
  };
}

/** Profile lint's sources over the copy. The standing check's page reads, the artifact store and the preparation store fail the case if asked. */
function sourcesOver(log: string[] = [], graph: GraphStoreReads = graphOver(log)): ProfileLintSources {
  return {
    scans: entityScansOf(project.copy, project.onDisk.real, (call) => { log.push(call); }),
    graph, events: eventsOver(graph, log),
    pages: { readEntityPage: unasked("pages.readEntityPage") },
    artifacts: { graph, artifacts: { artifactAt: unasked("artifacts.artifactAt") }, provenance: unaskedPreparationStore("provenance") },
  };
}

/** The marker reads over the copy: a held marker's raw text, or absent. */
function markersOver(log: string[] = []): EmbeddingMarkerReads {
  return { readMarkerText: async (markerFile) => {
    log.push(`marker ${markerFile}`);
    const body = project.copy.files.get(markerFile);
    return body === undefined ? { kind: "absent" } : { kind: "ok", body };
  } };
}

const evaluated = async (sources: ProfileLintSources): Promise<ProfileLintCollection> => collectProfileLintFindings(await collectProfileLintInputFrom(sources, SAMPLE_PROFILE));
const rulesOf = (results: LintResult[]): string[] => results.map((result) => result.rule).sort();

describe("profile lint over a copied legacy-profile project, with the directory gone", () => {
  it("F1 runs after the minting directory was removed, on a copy holding the profile and both raw markers, and no journal or binding leaf", () => {
    expectRemovedLegacyProfileCopies([project], PREFIX);
    expect([PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE].filter((rel) => !project.copy.files.has(rel))).toEqual([]);
    expect(project.copy.listings.has(WIKI_GRAPH_DIR)).toBe(false);
  });

  it("F2 evaluates exactly what the root-taking forms answered on disk: findings, reported files, order and declared tiers", async () => {
    const collection = await evaluated(sourcesOver());
    expect(collection).toEqual(project.onDisk.profileLint);
    expect(collection.results).toEqual(project.onDisk.entities);
  });

  it("F3 flags each page-derived finding once, every one tagged with its entity type, and asks the absent stores in order: relations, then events and the head anchor", async () => {
    const log: string[] = [];
    const { results } = await evaluated(sourcesOver(log));
    expect(rulesOf(results)).toEqual(["empty-page", "malformed-claim-citation", "profile/field-violation", "profile/non-slug-safe-filename", "profile/slug-mismatch"]);
    expect(results.filter((result) => result.entityType !== "notes")).toEqual([]);
    const stores = log.filter((call) => call.startsWith("graph ") || call.startsWith("events."));
    expect([stores.slice(0, 3), stores.filter((call) => call.startsWith("graph ")).length]).toEqual([["graph relations.jsonl", "graph events.jsonl", "events.private"], 2]);
    expect(log.indexOf("graph relations.jsonl")).toBeGreaterThan(log.findIndex((call) => call.startsWith("open ")));
  });

  it("F4 turns a store's own link error into one store-level finding per store, and passes any other read error on untouched", async () => {
    const baseline = project.onDisk.profileLint.results.length;
    const linked = await evaluated(sourcesOver([], graphOver([], (config) => config.makeSymlinkError("planted link"))));
    expect(linked.results.slice(baseline).map((result) => `${result.rule}:${result.file}`)).toEqual([
      `relation-store-symlink:${WIKI_GRAPH_DIR}/relations.jsonl`, `event-store-symlink:${WIKI_GRAPH_DIR}/events.jsonl`,
    ]);
    const failure = new Error("planted graph read failure");
    await expect(evaluated(sourcesOver([], graphOver([], () => failure)))).rejects.toBe(failure);
  });

  it("F5 rejects with the entity scan's own error before any store is read", async () => {
    const failure = new Error("planted scan failure");
    const log: string[] = [];
    const sources: ProfileLintSources = { ...sourcesOver(log), scans: { openEntityDirectory: async () => { throw failure; } } };
    await expect(evaluated(sources)).rejects.toBe(failure);
    expect(log).toEqual([]);
  });
});

describe("the journal and embedding health rules over the same copy", () => {
  it("F6 journal health: nothing for the absent journal, as on disk, and one coded warning for a journal that cannot be vouched for", async () => {
    expect([await checkJournalHealthFrom(absentJournalOf(() => {})), project.onDisk.journal]).toEqual([[], []]);
    const escaped = await checkJournalHealthFrom({ openJournal: async () => ({ kind: "escape" }) });
    expect(escaped.map((one) => [one.rule, one.severity, one.file, one.message.startsWith(`${JOURNAL_UNAVAILABLE_CODE}: `)])).toEqual([["journal-health", "warning", ".llmwiki/journal", true]]);
  });

  it("F7 embedding health: the pending and the quarantined warning the disk rule gave, from the raw markers, each marker read twice", async () => {
    const log: string[] = [];
    const findings = await checkPendingEmbeddingsFrom(markersOver(log));
    expect(findings).toEqual(project.onDisk.embeddings);
    expect(findings.map((one) => [one.rule, one.file, one.message.split(":")[0]])).toEqual([
      ["pending-embeddings", PENDING_EMBEDDINGS_FILE, "embeddings-refresh-pending"], ["quarantined-embeddings", QUARANTINED_EMBEDDINGS_FILE, "embeddings-refresh-quarantined"],
    ]);
    expect([log.length, log.filter((call) => call === `marker ${PENDING_EMBEDDINGS_FILE}`).length]).toEqual([4, 2]);
  });
});
