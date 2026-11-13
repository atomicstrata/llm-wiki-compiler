/**
 * @file test/storage/profile-summary-binding.test.ts
 * @description The profile summary over its sources. This file uses
 * `collectProfileSummaryFrom`, which exists only after the summary was given
 * sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. In-memory doubles decide nothing: `binding`
 * and `profile` (no binding leaf; a legacy profile's text, or none), `scans`
 * (the existing entity-scan binding), `graph` (the graph-store read, serving
 * the relation store and the event store by the file name it is asked for),
 * `events` (the head anchor's directory and leaf), `pages` (one entity page),
 * `artifacts` (the artifact store's leaf reads), `provenance` (artifact
 * health's one question) and `summary.realRoot`.
 *
 * WHAT IS LOGGED. Every method of every double, the methods of the directory
 * object a scan hands back included, logs to ONE shared, ordered log BEFORE it
 * returns or throws, under its group name. The summary makes its calls one
 * after another, so the whole log is asserted in order.
 *
 * ARTIFACT HEALTH runs for real over the same doubles: its third scan, its
 * relation read and its real-path look are in the one log. THE ARTIFACT
 * RESOLVER RUNS FOR REAL TOO, over the shared raw-leaf double of
 * `artifact-store-double.ts`: every artifact asked about has an honest sidecar
 * and body unless the case holds a state for its slug, which only changes the
 * leaves served (a changed body of equal length, no leaves at all, or an
 * `Error` both reads reject with). The verdict is the resolver's own.
 * THE PROVENANCE VERIFIER RUNS FOR REAL as well, over the shared EMPTY
 * preparation store of `preparation-store-doubles.ts`: no preparation is in
 * it, so every armed check DENIES with the verifier's own wording, unless the
 * case refuses that check's lifecycle borrow, which PARKS. Its lifecycle read
 * is one the test vouches for. What IS shown is everything the health check
 * decides: the gate, which pages and relation attributes are resolved and
 * checked and in what order, the leaf reads each makes, what a verdict
 * becomes, and the conditional real-path look. NOT SHOWN ANY MORE: which
 * profile object the resolver is handed, and THAT A PASS BECOMES NO PROBLEM:
 * a passing verdict needs a run that admitted the pinned output, and none is
 * fabricated here. `provenance-store-binding.test.ts` and
 * `gated-provenance-health-binding.test.ts` run the verifier over real
 * preparation records.
 *
 * The production summary runs on what the doubles serve: the default gate, the
 * order of the reads, the standing check's two short circuits and its single
 * relation read, which failure becomes which problem and which rejects, store
 * problems first, and the real-path look made last and always.
 *
 * NOT SHOWN HERE: anything about the disk. `profile-status.test.ts`,
 * `profile-viewer.test.ts`, `relation-standing-surfaces.test.ts`,
 * `graph-dir-confine-surfaces.test.ts` and
 * `artifacts/artifact-health-surfaces.test.ts` show the summary on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { eventPrevHash } from "../../src/events/event-digest.js";
import type { HeadLeafRead } from "../../src/events/store-read.js";
import { eventHeaderLine, serializeEventRecord } from "../../src/events/store-record.js";
import { GENESIS_PREV_HASH, type EventContent } from "../../src/events/types.js";
import { hashArtifactBody } from "../../src/artifacts/store.js";
import { collectProfileSummaryFrom, type ProfileSummarySources } from "../../src/profile/block.js";
import type { ExecutionProvenanceReq, ProfilePack } from "../../src/profile/types.js";
import { recordChecksum } from "../../src/relations/store-record.js";
import type { RelationRef } from "../../src/relations/types.js";
import type { LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import type { ConfinedPageRead } from "../../src/utils/confined-read.js";
import { OTHER_ARTIFACT_TYPE, researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_FILE, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import { noBindingLeafDouble } from "../fixtures/no-binding-leaf-double.js";
import { genericGatedProfile } from "../fixtures/profile-fixtures.js";
import { artifactStoreOver } from "./artifact-store-double.js";
import { emptyPreparationStore } from "./preparation-store-doubles.js";

const DISPLAY_ROOT = "/display/only/project";
const REAL_ROOT = "/real/root";
/** The shared generic gated profile: an `alpha` page in `sealed` needs one `bonds` relation to a `beta`. */
const GATED = genericGatedProfile();
const PLAIN = { schemaVersion: 1, profileId: "plain", entities: { notes: { directory: "wiki/notes" } } };
const WITH_ARTIFACTS = {
  schemaVersion: 1, profileId: "artifact-health",
  entities: { papers: { directory: "wiki/papers", fields: { title: { type: "string" }, resultRef: { type: "artifactRef", artifactTypes: ["experiment-result"] } } } },
  artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 65536, metadata: { accuracy: { type: "number", required: true } } } },
};
const BETA = "---\ntitle: Beta One\n---\n\nBeta body.\n";
const SEALED = "---\ntitle: Alpha One\nmode: sealed\n---\n\nAlpha body.\n";
const OPEN = "---\ntitle: Alpha One\nmode: open\n---\n\nAlpha body.\n";
const BOND = { id: "rel_one", type: "bonds", from: "alpha/a1", to: "beta/b1", attributes: {}, contentHash: "c" } as unknown as RelationRef;
/** A relation store holding one record with its real checksum. */
const storeOf = (ref: RelationRef): string => `${JSON.stringify({ kind: "relation-store-header", schemaVersion: 1 })}\n${JSON.stringify({ ...ref, checksum: recordChecksum(ref) })}\n`;
const RELATIONS = storeOf(BOND);
const EVENT: EventContent = { id: "evt_1", type: "relation-create", origin: "test", payload: {}, at: "2026-01-01T00:00:00Z" };
const EVENTS = eventHeaderLine() + serializeEventRecord({ ...EVENT, prevHash: GENESIS_PREV_HASH });
const SEALED_HEAD: HeadLeafRead = { kind: "text", text: eventPrevHash(EVENT) };
/** The body every honest artifact here holds, a changed body of the SAME length, and the honest body's real hash, which every ref pins. */
const ARTIFACT_BODY = `{"accuracy":0.9}`;
const CHANGED_BODY = `{"accuracy":0.1}`;
const HEX = hashArtifactBody(ARTIFACT_BODY);
/** The leaf file a second declared type keeps its body in. */
const OTHER_FILE = "note.json";
/** A hash-pinned artifact ref, in the compact form a page field or a relation attribute carries. */
const refOf = (slug: string, type: string = RESEARCH_ARTIFACT_TYPE): string => `${type}/${slug}@sha256:${HEX}`;
const PROVENANCE: ExecutionProvenanceReq = { actionId: "run-experiment", slugInputField: "experiment", resultOutputId: "result" };
/**
 * The shared research artifact profile (an `experiments` page in `complete`
 * needs a `result` ref), with a `cites` relation whose `evidence` attribute
 * pins an artifact too, and a second declared type so that a ref of the wrong
 * type still resolves. `armed` adds the execution-provenance requirement.
 */
function artifactProfile(armed: boolean): ProfilePack {
  const profile = researchArtifactPreconditionProfile();
  profile.artifacts![OTHER_ARTIFACT_TYPE] = { fileName: OTHER_FILE, contentKind: "json", maxBytes: 65536 };
  if (armed) profile.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].executionProvenance = PROVENANCE;
  const evidence = { type: "artifactRef" as const, artifactTypes: [RESEARCH_ARTIFACT_TYPE] };
  profile.relations = { cites: { from: ["experiments"], to: ["experiments"], direction: "directed", attributes: { evidence } } };
  return profile;
}
/** One `experiments` page in `stage`, pinning `result` when one is given. */
const experiment = (stage: string, result?: string): string => `---\ntitle: E\nstage: ${stage}\n${result ? `result: ${result}\n` : ""}---\n\nBody.\n`;
const CITES = { id: "rel_cites", type: "cites", from: "experiments/e1", to: "experiments/e2", attributes: { evidence: refOf("shared") }, contentHash: "c" } as unknown as RelationRef;

interface Held {
  profile?: object;
  pages?: Record<string, Record<string, string>>;
  /** What the graph read answers per store file; `"link"` throws what the asking reader's own factory builds. */
  relations?: string | null | "link" | Error;
  events?: string | null | Error;
  head?: HeadLeafRead | "link";
  endpoint?: ConfinedPageRead;
  realRoot?: string | null;
  /** What state an artifact's leaves are in, by slug: a changed body, no leaves, or an `Error` both reads reject with. A slug not held is honest. */
  health?: Record<string, "artifact-bytes-tampered" | "artifact-dangling" | Error>;
  /** Which provenance checks, counted from 1 in the order they are made, find the preparation store's lifecycle borrow refused. */
  refusedScans?: readonly number[];
}

/** The error a refused lifecycle borrow rejects with. */
const SCAN_REFUSED = new Error("lifecycle borrow refused");

/** The entity-scan binding over `pages`; entry locators sit under {@link REAL_ROOT}, as real paths do on disk. */
function scansOf(pages: Record<string, Record<string, string>>, note: (call: string) => void): LegacyLocalEntityScans {
  return { openEntityDirectory: async (relDir) => {
    note(`scans.openEntityDirectory ${relDir}`);
    const held = pages[relDir] ?? {};
    const textOf = (entry: string): string => held[entry.slice(`${REAL_ROOT}/${relDir}/`.length)]!;
    return { status: "ok", directory: {
      listNames: async () => { note(`scans.directory.listNames ${relDir}`); return Object.keys(held); },
      resolveEntry: async (name) => { note(`scans.directory.resolveEntry ${relDir}/${name}`); return `${REAL_ROOT}/${relDir}/${name}`; },
      readPrefix: async (entry, maxBytes) => { note(`scans.directory.readPrefix ${entry}`); return Buffer.from(textOf(entry)).subarray(0, maxBytes); },
      readText: async (entry) => { note(`scans.directory.readText ${entry}`); return textOf(entry); },
    } };
  } };
}

/** The graph-store read: it serves the relation store or the event store by the file name it is asked for. */
function graphOf(held: Held, note: (call: string) => void): ProfileSummarySources["graph"] {
  return { readStore: async (config) => {
    note(`graph.readStore ${config.fileName}`);
    const answer = config.fileName === "relations.jsonl" ? held.relations : held.events;
    if (answer === "link") throw config.makeSymlinkError("store file is a symlink");
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  } };
}

/** The raw leaf one artifact holds at `rel` (`artifacts/<type>/<slug>/<leaf>`), given the state the case holds for its slug. */
function artifactLeaf(states: NonNullable<Held["health"]>, rel: string): string | Error | undefined {
  const [, artifactType, slug] = rel.split("/");
  const state = states[slug];
  if (state instanceof Error) return state;
  if (state === "artifact-dangling") return undefined;
  if (!rel.endsWith(".manifest.json")) return state === undefined ? ARTIFACT_BODY : CHANGED_BODY;
  return JSON.stringify({
    artifactType, slug, sha256: HEX, bytes: Buffer.byteLength(ARTIFACT_BODY, "utf8"), contentKind: "json", writtenAt: "2026-01-01T00:00:00Z",
  });
}

/** The artifact store's leaf reads, and an empty preparation store. Each logs BEFORE it answers. */
function artifactQuestionsOf(held: Held, note: (call: string) => void): Pick<ProfileSummarySources, "artifacts" | "provenance"> {
  const states = held.health ?? {};
  const refused = new Set(held.refusedScans ?? []);
  return {
    artifacts: artifactStoreOver({ get: (rel) => artifactLeaf(states, rel) }, note),
    provenance: emptyPreparationStore("provenance", note, (scan) => (refused.has(scan) ? SCAN_REFUSED : undefined)),
  };
}

/** All sources over one shared log. */
function sourcesOf(held: Held = {}) {
  const absent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const calls: string[] = [];
  const note = (call: string): void => { calls.push(call); };
  const binding = noBindingLeafDouble(note);
  const graph = graphOf(held, note);
  const sources: ProfileSummarySources = {
    profile: {
      activeProduct: { root: DISPLAY_ROOT, binding, packages: {} } as unknown as ProfileSummarySources["profile"]["activeProduct"],
      readPrivateLeafText: async (dir, name) => {
        note(`profile.readPrivateLeafText ${dir}/${name}`);
        return held.profile === undefined ? { kind: "not-opened", error: absent } : { kind: "text", text: JSON.stringify(held.profile) };
      },
    },
    scans: scansOf(held.pages ?? {}, note), graph,
    events: {
      graph,
      resolvePrivateDir: async () => { note("events.resolvePrivateDir"); return "mem:private"; },
      readHeadLeaf: async (dir, name, _maxBytes, makeSymlinkError) => {
        note(`events.readHeadLeaf ${dir}/${name}`);
        if (held.head === "link") throw makeSymlinkError("store file is a symlink");
        return held.head ?? { kind: "absent" };
      },
    },
    pages: { readEntityPage: async (directory, slug) => { note(`pages.readEntityPage ${directory} ${slug}`); return held.endpoint ?? { kind: "ok", body: BETA }; } },
    ...artifactQuestionsOf(held, note),
    realRoot: async () => { note("summary.realRoot"); return held.realRoot === undefined ? REAL_ROOT : held.realRoot; },
  };
  return { sources, calls };
}

const PROFILE_CALLS = ["binding.readBindingLeaf max=65536", "binding.resolvePrivateDir", "profile.readPrivateLeafText mem:private/profile.json"];
const RELATION_READ = "graph.readStore relations.jsonl";
const EVENT_READS = ["graph.readStore events.jsonl", "events.resolvePrivateDir", "events.readHeadLeaf mem:private/events.head"];
const REAL = "summary.realRoot";
/** The frontmatter-only scan of one directory: open, list, then resolve and read the prefix of each name. */
const scan = (relDir: string, ...names: string[]): string[] => [
  `scans.openEntityDirectory ${relDir}`, `scans.directory.listNames ${relDir}`,
  ...names.flatMap((name) => [`scans.directory.resolveEntry ${relDir}/${name}`, `scans.directory.readPrefix ${REAL_ROOT}/${relDir}/${name}`]),
];
const summarize = async (held: Held) => { const made = sourcesOf(held); return { ...made, block: await collectProfileSummaryFrom(made.sources) }; };
const GATED_PAGES = { "wiki/beta": { "b1.md": BETA }, "wiki/alpha": { "a1.md": SEALED } };

describe("the profile summary over its sources: order", () => {
  it("M1 answers undefined for the built-in default profile and asks nothing after the profile", async () => {
    const { block, calls } = await summarize({});
    expect([block, calls]).toEqual([undefined, PROFILE_CALLS]);
  });

  it("M2 reads a gated project in one fixed order, and asks artifact health nothing without artifact types", async () => {
    const { block, calls } = await summarize({ profile: GATED, pages: GATED_PAGES, relations: RELATIONS, events: EVENTS, head: SEALED_HEAD });
    expect(block).toEqual({
      profileId: "generic-gated", digest: expect.any(String), entityCounts: { beta: 1, alpha: 1 },
      relationCounts: { bonds: 1 }, relationTotal: 1, eventCount: 1, lifecycleStates: { alpha: { sealed: 1 } },
    });
    expect(calls).toEqual([
      ...PROFILE_CALLS, ...scan("wiki/beta", "b1.md"), ...scan("wiki/alpha", "a1.md"), RELATION_READ, ...EVENT_READS,
      ...scan("wiki/alpha", "a1.md"), ...scan("wiki/alpha", "a1.md"), RELATION_READ, "pages.readEntityPage wiki/beta b1", REAL,
    ]);
  });

  it("M3 makes no standing scan without a gated type, and no standing relation read without a page in a gated state", async () => {
    const plain = await summarize({ profile: PLAIN, pages: { "wiki/notes": { "n1.md": BETA } } });
    expect(plain.calls).toEqual([...PROFILE_CALLS, ...scan("wiki/notes", "n1.md"), RELATION_READ, ...EVENT_READS, REAL]);
    expect(plain.block).toEqual({ profileId: "plain", digest: expect.any(String), entityCounts: { notes: 1 } });
    const open = await summarize({ profile: GATED, pages: { "wiki/alpha": { "a1.md": OPEN } }, relations: RELATIONS });
    expect(open.calls.filter((call) => call === RELATION_READ || call.startsWith("pages."))).toEqual([RELATION_READ]);
  });
});

const EXPERIMENTS = "wiki/experiments";
const TWO_PAGES = { [EXPERIMENTS]: { "e1.md": experiment("complete", refOf("e1")), "e2.md": experiment("running", refOf("shared")) } };
const SCAN_TWO = scan(EXPERIMENTS, "e1.md", "e2.md");
/** One resolve, as the resolver's leaf reads: the location, the sidecar, then the body, each under its 65536-byte cap. */
const RESOLVE = (slug: string, type: string = RESEARCH_ARTIFACT_TYPE, file: string = RESEARCH_ARTIFACT_FILE): string[] => [
  `artifacts.artifactAt ${type}/${slug} ${file}`, `artifacts.manifest ${type}/${slug} max=65536`, `artifacts.body ${type}/${slug} max=65536`,
];
/** One provenance check over the empty store: the borrow, its proof, then the walk that finds no workspaces. A refused borrow is the borrow alone. */
const VERIFY = ["provenance.borrow", "provenance.assert", "provenance.walk workspaces"];
const REFUSED_VERIFY = ["provenance.borrow"];
const REQUIRED = `field "result" required by lifecycle state "complete"`;
/** The verifier's own deny for a page slug over the empty store, under {@link PROVENANCE}; and its park when the borrow is refused. */
const DENIED = (slug: string): string =>
  `${REQUIRED}: no succeeded '${PROVENANCE.actionId}' run with ${PROVENANCE.slugInputField}=${JSON.stringify(slug)} admitted the pinned bytes under output '${PROVENANCE.resultOutputId}'`;
const PARKED = `${REQUIRED}: the preparation store could not be scanned: ${SCAN_REFUSED.message}`;
/** The artifact leaf reads and the provenance question only, in the order they were made. */
const asked = (calls: string[]): string[] => calls.filter((call) => /^(artifacts|provenance)\./.test(call));
/** The artifact problems only: an entity problem a page also raises is not this file's subject. */
const artifactMessages = (block: Awaited<ReturnType<typeof collectProfileSummaryFrom>>): string[] =>
  (block?.problems ?? []).filter((entry) => entry.kind === "artifact-store").map((entry) => entry.message);

describe("the profile summary over its sources: artifact health, order", () => {
  it("M4 asks artifact health in one fixed order: its own scan, a page's leaf reads then its provenance, the relation read, then both real-path looks", async () => {
    const { block, calls } = await summarize({ profile: artifactProfile(true), pages: TWO_PAGES, relations: storeOf(CITES), health: { e1: "artifact-bytes-tampered" } });
    expect(calls).toEqual([
      ...PROFILE_CALLS, ...SCAN_TWO, RELATION_READ, ...EVENT_READS, ...SCAN_TWO,
      ...SCAN_TWO, ...RESOLVE("e1"), ...VERIFY, ...RESOLVE("shared"), RELATION_READ, ...RESOLVE("shared"), REAL, REAL,
    ]);
    // The deny names the declared action, field and output: the requirement reached the verifier.
    expect([block?.problems, block?.problemTotal]).toEqual([[{
      kind: "artifact-store", entityType: "experiments", path: `${EXPERIMENTS}/e1.md`,
      message: `field "result" references ${refOf("e1")} (artifact-bytes-tampered): the artifact bytes no longer match its own manifest`,
    }, { kind: "artifact-store", entityType: "experiments", path: `${EXPERIMENTS}/e1.md`, message: DENIED("e1") }], 2]);
  });

  it("M10 scans for artifact health even with no page, and makes no artifact real-path look without a finding", async () => {
    const empty = await summarize({ profile: WITH_ARTIFACTS });
    expect(empty.calls).toEqual([...PROFILE_CALLS, ...scan("wiki/papers"), RELATION_READ, ...EVENT_READS, ...scan("wiki/papers"), REAL]);
    const healthy = await summarize({ profile: artifactProfile(false), pages: TWO_PAGES, relations: storeOf(CITES) });
    expect(asked(healthy.calls)).toEqual([...RESOLVE("e1"), ...RESOLVE("shared"), ...RESOLVE("shared")]);
    expect([healthy.block?.problems, healthy.calls.filter((call) => call === REAL)]).toEqual([undefined, [REAL]]);
  });
});

describe("the profile summary over its sources: artifact health, provenance", () => {
  it("M11 turns the real verifier's deny and park into one problem each, carrying its detail", async () => {
    const pages = { [EXPERIMENTS]: { "e1.md": experiment("complete", refOf("e1")), "e2.md": experiment("complete", refOf("e2")) } };
    const { block, calls } = await summarize({ profile: artifactProfile(true), pages, refusedScans: [2] });
    expect(asked(calls)).toEqual([...RESOLVE("e1"), ...VERIFY, ...RESOLVE("e2"), ...REFUSED_VERIFY]);
    expect(artifactMessages(block)).toEqual([DENIED("e1"), PARKED]);
    expect(block?.problems?.map((entry) => entry.path)).toEqual([`${EXPERIMENTS}/e1.md`, `${EXPERIMENTS}/e2.md`]);
  });

  it("M12 asks provenance nothing for an ungated page, a missing ref, a wrong-typed ref, or a requirement that declares none", async () => {
    const pages = { [EXPERIMENTS]: {
      "open.md": experiment("running", refOf("open")), "missing.md": experiment("complete"), "wrong.md": experiment("complete", refOf("wrong", OTHER_ARTIFACT_TYPE)),
    } };
    const armed = await summarize({ profile: artifactProfile(true), pages });
    expect(asked(armed.calls)).toEqual([...RESOLVE("open"), ...RESOLVE("wrong", OTHER_ARTIFACT_TYPE, OTHER_FILE)]);
    expect(artifactMessages(armed.block)).toEqual([
      `${REQUIRED} carries no resolvable ${RESEARCH_ARTIFACT_TYPE} artifact ref`, `${REQUIRED} pins a ${OTHER_ARTIFACT_TYPE} artifact but a ${RESEARCH_ARTIFACT_TYPE} is required`,
    ]);
    const unarmed = await summarize({ profile: artifactProfile(false), pages: { [EXPERIMENTS]: { "e1.md": experiment("complete", refOf("e1")) } } });
    expect([asked(unarmed.calls), unarmed.block?.problems]).toEqual([RESOLVE("e1"), undefined]);
  });
});

describe("the profile summary over its sources: artifact health, failures", () => {
  it("M13 swallows a failed relation read inside artifact health, whatever was thrown, and keeps the page findings", async () => {
    const made = sourcesOf({ profile: artifactProfile(true), pages: TWO_PAGES, relations: storeOf(CITES), health: { e1: "artifact-dangling" } });
    const readStore = made.sources.graph.readStore;
    let relationReads = 0;
    made.sources.graph.readStore = async (config) => {
      if (config.fileName !== "relations.jsonl" || ++relationReads === 1) return readStore(config);
      made.calls.push(RELATION_READ);
      throw new Error("EIO: read refused");
    };
    const block = await collectProfileSummaryFrom(made.sources);
    expect([relationReads, asked(made.calls), made.calls.slice(-3)]).toEqual([2, [...RESOLVE("e1"), ...VERIFY, ...RESOLVE("shared")], [RELATION_READ, REAL, REAL]]);
    expect(artifactMessages(block)).toEqual([`field "result" references ${refOf("e1")} (artifact-dangling): the artifact does not exist`, DENIED("e1")]);
  });

  it("M14 rejects with a leaf read's own error as the same object, and asks nothing after it", async () => {
    const refused = new Error("EIO: artifact read refused");
    const made = sourcesOf({ profile: artifactProfile(true), pages: TWO_PAGES, relations: storeOf(CITES), health: { e1: refused } });
    await expect(collectProfileSummaryFrom(made.sources)).rejects.toBe(refused);
    expect(made.calls.slice(-2)).toEqual(RESOLVE("e1").slice(0, 2));
  });
});

describe("the profile summary over its sources: problems and failures", () => {
  const NO_MODE = "---\ntitle: No Mode\n---\n\nBody.\n";
  const violating = { profile: GATED, pages: { "wiki/alpha": { "bad.md": NO_MODE } } };

  it("M5 puts a store problem before an entity problem, and relativises the entity path against the real root", async () => {
    const { block, calls } = await summarize({ ...violating, relations: "link" });
    expect(block?.problems?.map((entry) => [entry.kind, entry.path])).toEqual([["relation-store", undefined], ["field-violation", "wiki/alpha/bad.md"]]);
    expect([block?.problemTotal, block?.entityCounts, "relationCounts" in block!, calls.at(-1)]).toEqual([2, { beta: 0, alpha: 0 }, false, REAL]);
  });

  it("M6 falls back to the root as given when the real path is unknown, and asks for it with no problem at all", async () => {
    const unknown = await summarize({ ...violating, realRoot: null });
    expect(unknown.block?.problems?.map((entry) => entry.path)).toEqual(["../../../real/root/wiki/alpha/bad.md"]);
    const clean = await summarize({ profile: PLAIN, realRoot: null });
    expect([clean.block?.problems, clean.calls.at(-1)]).toEqual([undefined, REAL]);
  });

  it("M7 turns a linked head anchor into one event-store problem and suppresses the count", async () => {
    const { block } = await summarize({ profile: PLAIN, events: EVENTS, head: "link" });
    expect([block?.problems?.map((entry) => entry.kind), "eventCount" in block!]).toEqual([["event-store"], false]);
  });

  it("M8 reports an unreadable endpoint page as the one cannot-verify standing problem", async () => {
    const cause = Object.assign(new Error("EIO: page read refused"), { code: "EIO" });
    const { block } = await summarize({ profile: GATED, pages: GATED_PAGES, relations: RELATIONS, endpoint: { kind: "unreadable", cause } });
    expect(block?.problems?.map((entry) => entry.kind)).toEqual(["lifecycle-relation-requirement-unverifiable"]);
  });

  it("M9 rejects with an untyped store failure as the same object, and reads nothing after it", async () => {
    const refused = new Error("EIO: read refused");
    const relations = sourcesOf({ profile: PLAIN, relations: refused });
    await expect(collectProfileSummaryFrom(relations.sources)).rejects.toBe(refused);
    expect(relations.calls).toEqual([...PROFILE_CALLS, ...scan("wiki/notes"), RELATION_READ]);
    const events = sourcesOf({ profile: PLAIN, events: refused });
    await expect(collectProfileSummaryFrom(events.sources)).rejects.toBe(refused);
    expect(events.calls.at(-1)).toBe("graph.readStore events.jsonl");
  });
});
