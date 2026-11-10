/**
 * @file test/storage/evidence-capture-binding.test.ts
 * @description The evidence-capture consumers as root-free bodies over their
 * reads, each against its unchanged root facade: the artifact-evidence capture
 * (`captureArtifactEvidenceInputFrom`), and the source-evidence capture and its
 * runtime spec builder (`captureSourceEvidenceInputFrom`,
 * `buildSourceEvidenceSpecsFrom`) over the one shared source read, and the
 * page-evidence capture and its runtime re-verification
 * (`capturePageEvidenceInputFrom`, `buildPageEvidenceSpecsFrom`) over
 * `PageEvidenceReads`. Their bound-over-seams parity on a real project lives in
 * the page-evidence synthetic suite, beside its fixture.
 *
 * HOW IT IS BUILT. A real member-bearing bundle is written with the existing
 * fixtures. The root facade's answer is compared with the body run over the
 * EXISTING seams (`artifactEvidenceReadsOver`: the profile loader's and the
 * artifact resolver's own sources). Memory reads that log every call pin the
 * body's refusal ladder and its order: the profile first, then the full
 * resolution, then the body re-read bound to the ref's hash. The last case shows
 * the root facade reaching each incumbent reader with exact arguments. The
 * source cases hold the retained sources in a memory map: the capture's columns
 * and the builder's specs must equal what the root facades produce on disk.
 *
 * NOT SHOWN HERE: confinement, the member verification itself, and the runtime
 * re-verification. Those belong to the resolver's and the runtime builder's own
 * suites.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as artifactResolve from "../../src/artifacts/resolve.js";
import * as artifactStore from "../../src/artifacts/store.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import * as profileBlock from "../../src/profile/block.js";
import { buildSourceEvidenceSpecs, buildSourceEvidenceSpecsFrom } from "../../src/operations-packs/runtime/source-evidence.js";
import { diskEffectiveProfileSources } from "../../src/profile/load.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import {
  artifactEvidenceReadsOver, captureArtifactEvidenceInput, captureArtifactEvidenceInputFrom, type ArtifactEvidenceReads,
} from "../../src/products/artifact-evidence-capture.js";
import { buildPageEvidenceSpecs, buildPageEvidenceSpecsFrom } from "../../src/operations-packs/runtime/page-evidence.js";
import { capturePageEvidenceInput, capturePageEvidenceInputFrom } from "../../src/products/page-evidence-capture.js";
import type { PageEvidenceReads } from "../../src/products/page-evidence-forms.js";
import { captureSourceEvidenceInput, captureSourceEvidenceInputFrom } from "../../src/products/source-evidence-capture.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import type { SourceLeafReads } from "../../src/utils/flat-source-leaf.js";
import { EVIDENCE_DESCRIPTOR } from "../fixtures/artifact-evidence-fixture.js";
import { tempRootTracker } from "../temp-roots.js";
import { BUNDLE_FILE, bundlePaths, makeMembersRoot, twoMembers, writeBundle } from "../fixtures/member-artifact-root.js";

/** A minimal pack whose one action's recipe carries `descriptor` (or none) under `key`. */
const packWith = (descriptor: object | undefined, key = "artifactEvidenceDescriptor"): WorkspaceOperationsPackV2 => ({
  actions: { "demo.run": { execution: { recipeRef: "demo.recipe" } } },
  recipes: { "demo.recipe": { phases: [{ phaseId: "extract", kind: "provider", body: descriptor === undefined ? {} : { [key]: descriptor } }] } },
} as unknown as WorkspaceOperationsPackV2);
const PACK = packWith(EVIDENCE_DESCRIPTOR);
/** The caller's input naming `ref`, pinned by its hash. */
const pinned = (ref: { artifactType: string; slug: string; sha256: string }) => ({ "bundle-ref": `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}` }) as never;

/** Fixture roots this file made; the member-root fixture leaves their removal to the caller. */
const roots: string[] = [];

/** One real bundle: its root, ref, profile, and the body bytes the store holds. */
async function realBundle(prefix: string) {
  const root = await makeMembersRoot(prefix);
  roots.push(root);
  const ref = await writeBundle(root, twoMembers());
  const loaded = await profileBlock.loadNonDefaultProfile(root);
  const body = await artifactStore.readArtifactBody(root, bundlePaths(root), 65536);
  if (loaded === undefined || body.kind !== "ok") throw new Error("fixture bundle unreadable");
  return { root, ref, loaded, body: body.body };
}

/** Memory reads answering a profile, a resolution health and a body, each call logged. */
function memoryReads(log: string[], answers: { loaded?: LoadedProfile; health?: string; body?: string | null }): ArtifactEvidenceReads {
  return {
    nonDefaultProfile: async () => { log.push("profile"); return answers.loaded; },
    resolve: async (_profile, ref) => { log.push(`resolve ${ref.slug}`); return { health: answers.health ?? "ok" } as never; },
    readBody: async (type, slug, fileName, maxBytes) => {
      log.push(`body ${type}/${slug}/${fileName} ${maxBytes}`);
      return answers.body === null || answers.body === undefined ? { kind: "absent" } : { kind: "ok", body: answers.body };
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the artifact-evidence capture as a root-free body", () => {
  it("A1 answers what the root facade answers, over the profile's and the resolver's own seams", async () => {
    const { root, ref } = await realBundle("evidence-a1");
    const onDisk = await captureArtifactEvidenceInput(root, PACK, "demo.run", pinned(ref));
    const bound = await captureArtifactEvidenceInputFrom(
      artifactEvidenceReadsOver(diskEffectiveProfileSources(root), artifactResolve.diskArtifactStoreReads(root)), PACK, "demo.run", pinned(ref));
    expect(bound).toEqual(onDisk);
    expect("input" in onDisk && onDisk.input["member-names"]).toEqual(["figure.bin", "main.tex"]);
  });

  it("A2 refuses in ladder order: no read without a descriptor or a pinned ref, then the profile, the type, the resolution, the body", async () => {
    const { ref, loaded, body } = await realBundle("evidence-a2");
    const run = async (answers: Parameters<typeof memoryReads>[1], pack = PACK, input = pinned(ref)) => {
      const log: string[] = [];
      const outcome = await captureArtifactEvidenceInputFrom(memoryReads(log, answers), pack, "demo.run", input);
      return [("refused" in outcome ? outcome.refused : "captured"), log];
    };
    const BODY = `body bundle/${ref.slug}/${BUNDLE_FILE} 65536`;
    expect(await run({ loaded }, packWith(undefined))).toEqual(["captured", []]);
    expect(await run({ loaded }, PACK, { "bundle-ref": "bundle/probe" } as never)).toEqual(["artifact-evidence input carries no pinned ref under bundle-ref", []]);
    expect(await run({})).toEqual(["artifact evidence requires an active profile", ["profile"]]);
    expect(await run({ loaded, health: "artifact-bytes-tampered" })).toEqual(["the pinned bundle artifact is artifact-bytes-tampered", ["profile", `resolve ${ref.slug}`]]);
    expect(await run({ loaded, body: null })).toEqual(["the pinned artifact's manifest is absent", ["profile", `resolve ${ref.slug}`, BODY]]);
    expect(await run({ loaded, body: `${body} ` })).toEqual(["the pinned artifact was rewritten during capture; retry", ["profile", `resolve ${ref.slug}`, BODY]]);
    expect(await run({ loaded, body })).toEqual(["captured", ["profile", `resolve ${ref.slug}`, BODY]]);
  });

  it("A3 makes no ambient read from the body, while the root facade reaches each incumbent reader with exact arguments", async () => {
    const { root, ref, loaded, body } = await realBundle("evidence-a3");
    const spies = [vi.spyOn(profileBlock, "loadNonDefaultProfile"), vi.spyOn(artifactResolve, "resolveArtifactRef"), vi.spyOn(artifactStore, "readArtifactBody")];
    await captureArtifactEvidenceInputFrom(memoryReads([], { loaded, body }), PACK, "demo.run", pinned(ref));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    await captureArtifactEvidenceInput(root, PACK, "demo.run", pinned(ref));
    expect(spies[0]).toHaveBeenCalledWith(root);
    expect(spies[1]).toHaveBeenCalledWith(root, loaded.profile, ref);
    expect(spies[2]).toHaveBeenCalledWith(root, artifactStore.artifactPaths(root, ref.artifactType, ref.slug, BUNDLE_FILE), 65536);
  });
});

/** The sealed source descriptor the source cases share (the incumbent suite's shape). */
const SOURCE = {
  pathsField: "source-paths", digestsField: "source-digests", byteCountsField: "source-byte-counts", inputIdPrefix: "src", kind: "source-evidence",
  provenanceLabel: "retained-source", mediaType: "text/markdown", maxItems: 3, maxBytes: 64, pathTableKey: "source-files",
} as const;
const SOURCE_PACK = packWith(SOURCE, "sourceEvidenceDescriptor");
const SOURCES = { "alpha.md": "Alpha source.\n", "beta.md": "Beta source text.\n" };

/** The retained sources held in a map; every read is logged with its cap. */
function sourceReadsOf(held: Record<string, string>, log: string[]): SourceLeafReads {
  return {
    readSourceLeaf: async (relative, maxBytes) => {
      log.push(`read ${relative} ${maxBytes}`);
      const text = held[relative];
      return text === undefined ? { kind: "absent" } : { kind: "ok", body: Buffer.from(text) };
    },
  };
}

/** The source projects' owned temp roots, removed after each case. */
const sourceRoots = tempRootTracker();
afterEach(() => sourceRoots.cleanup());

/** A real project, in a freshly allocated temp root, whose `sources/` holds `SOURCES`. */
async function sourcesRoot(): Promise<string> {
  const root = await sourceRoots.create("evidence-sources-");
  await mkdir(path.join(root, "sources"), { recursive: true });
  for (const [name, text] of Object.entries(SOURCES)) await writeFile(path.join(root, "sources", name), text);
  return root;
}

describe("the source-evidence capture and runtime builder as root-free bodies over the one source read", () => {
  it("S1 capture and build over a memory map answer what the root facades answer on disk", async () => {
    const root = await sourcesRoot();
    const input = { "source-paths": ["alpha.md", "beta.md"] } as never;
    const onDisk = await captureSourceEvidenceInput(root, SOURCE_PACK, "demo.run", input);
    const log: string[] = [];
    expect(await captureSourceEvidenceInputFrom(sourceReadsOf(SOURCES, log), SOURCE_PACK, "demo.run", input)).toEqual(onDisk);
    if (!("input" in onDisk)) throw new Error(onDisk.refused);
    const built = await buildSourceEvidenceSpecsFrom(sourceReadsOf(SOURCES, log), SOURCE, onDisk.input as never);
    expect(built).toEqual(await buildSourceEvidenceSpecs(root, SOURCE, onDisk.input as never));
    expect([built.status, log]).toEqual(["ok", ["read alpha.md 64", "read beta.md 64", "read alpha.md 64", "read beta.md 64"]]);
  });

  // These ladder cases run over the memory map only: the oversized leaf is a synthetic `ok` read, so they make no
  // claim about the disk read's own cap, only about the order and the strings the body refuses with.
  it("S2 the capture refuses a non-flat path before reading it, and stops at the first failed read or the byte cap", async () => {
    const run = async (paths: unknown, held: Record<string, string> = SOURCES) => {
      const log: string[] = [];
      const outcome = await captureSourceEvidenceInputFrom(sourceReadsOf(held, log), SOURCE_PACK, "demo.run", { "source-paths": paths } as never);
      return ["refused" in outcome ? outcome.refused : "captured", log];
    };
    expect(await run([])).toEqual(["source-evidence input names no source-paths", []]);
    expect(await run(["a", "b", "c", "d"])).toEqual(["4 source-evidence paths exceed the sealed maxItems of 3", []]);
    expect(await run(["alpha.md", "../x"])).toEqual(["source-evidence path \"../x\" is not a flat leaf under sources/", ["read alpha.md 64"]]);
    expect(await run(["gone.md", "alpha.md"])).toEqual(["source gone.md is absent under sources/", ["read gone.md 64"]]);
    expect(await run(["big.md"], { "big.md": "x".repeat(65) })).toEqual(["source-evidence bytes exceed the sealed maxBytes of 64", ["read big.md 64"]]);
  });

  it("S3 the builder refuses invalid columns and the item cap before any read, then unconfined paths, failed reads, and drift", async () => {
    const value = (paths: string[], digests: string[], counts: string[]) => ({ "source-paths": paths, "source-digests": digests, "source-byte-counts": counts });
    const sha = `sha256:${"0".repeat(64)}`;
    const run = async (sealed: Record<string, unknown>) => {
      const log: string[] = [];
      const outcome = await buildSourceEvidenceSpecsFrom(sourceReadsOf(SOURCES, log), SOURCE, sealed);
      return [outcome.status === "ok" ? "ok" : outcome.reason, log];
    };
    expect(await run(value(["alpha.md"], [], ["1"]))).toEqual(["source-evidence-columns-invalid", []]);
    expect(await run(value(["a", "b", "c", "d"], [sha, sha, sha, sha], ["1", "1", "1", "1"]))).toEqual(["source-evidence-over-item-cap", []]);
    expect(await run(value(["../x"], [sha], ["1"]))).toEqual(["source-evidence-path-unconfined", []]);
    expect(await run(value(["gone.md"], [sha], ["1"]))).toEqual(["source-evidence-read-absent", ["read gone.md 64"]]);
    expect(await run(value(["alpha.md"], [sha], ["14"]))).toEqual(["source-evidence-digest-drift", ["read alpha.md 64"]]);
  });

  it("S4 makes no ambient read from either body, while both root facades reach the confined read under sources/ with exact arguments", async () => {
    const root = await sourcesRoot();
    const spy = vi.spyOn(confinedRead, "readConfinedLeafBuffer");
    const input = { "source-paths": ["alpha.md"] } as never;
    const captured = await captureSourceEvidenceInputFrom(sourceReadsOf(SOURCES, []), SOURCE_PACK, "demo.run", input);
    await buildSourceEvidenceSpecsFrom(sourceReadsOf(SOURCES, []), SOURCE, ("input" in captured ? captured.input : {}) as never);
    expect(spy).not.toHaveBeenCalled();
    await captureSourceEvidenceInput(root, SOURCE_PACK, "demo.run", input);
    await buildSourceEvidenceSpecs(root, SOURCE, ("input" in captured ? captured.input : {}) as never);
    const sources = path.join(root, "sources");
    expect(spy.mock.calls.map((call) => call.slice(0, 4))).toEqual([[sources, path.join(sources, "alpha.md"), sources, 64], [sources, path.join(sources, "alpha.md"), sources, 64]]);
  });
});

/** A gadget page measured by widgets: one page-field capture and one relation-target capture. */
const PAGE_DESCRIPTOR = {
  pathTableKey: "page-evidence-files", target: { entityType: "gadgets", slugField: "slug" },
  captures: [
    { form: "page-field", captureId: "spec", field: "spec", inputId: "in-spec", provenanceLabel: "gadget-spec", kind: "page-evidence", mediaType: "text/plain", maxBytes: 64 },
    { form: "relation-target", captureId: "measured", relationType: "measures", sourceRole: "from", targetEntityType: "widgets", then: [] },
  ],
} as const;
const PAGE_PACK = packWith(PAGE_DESCRIPTOR, "pageEvidenceDescriptor");
const GADGETS = { profile: { entities: { gadgets: { directory: "wiki/gadgets", fields: { spec: {} } }, widgets: { directory: "wiki/widgets" } } } } as unknown as LoadedProfile;
const EDGE = { type: "measures", from: "gadgets/g-1", to: "widgets/w-1" };

/** Page-evidence reads over held answers; every call is logged, and the reads this shape never makes refuse. */
function pageReads(log: string[], answers: { loaded?: LoadedProfile; spec?: string; edges?: object[] }): PageEvidenceReads {
  const never = (name: string) => async (): Promise<never> => { throw new Error(`${name} is not read by these captures`); };
  return {
    nonDefaultProfile: async () => { log.push("profile"); return answers.loaded; },
    entityFrontmatter: async (def, slug) => {
      log.push(`page ${def.directory}/${slug}`);
      return def.directory === "wiki/widgets" || answers.spec !== undefined ? { kind: "frontmatter", meta: { spec: answers.spec } } : { kind: "absent" };
    },
    liveValidRelations: async () => { log.push("relations"); return (answers.edges ?? []) as never; },
    resolve: never("resolve"), readBody: never("readBody"), locateManifest: never("locateManifest"),
    initialInput: never("initialInput"), resolveRun: never("resolveRun"), evidenceBytes: never("evidenceBytes"),
  };
}

describe("the page-evidence capture and its runtime re-verification as root-free bodies", () => {
  it("P1 the capture refuses in ladder order before any read, then after the profile, the entity, the page, and each capture", async () => {
    const run = async (answers: Parameters<typeof pageReads>[1], input: Record<string, string> = { slug: "g-1" }) => {
      const log: string[] = [];
      const outcome = await capturePageEvidenceInputFrom(pageReads(log, answers), PAGE_PACK, "demo.run", input as never);
      return ["refused" in outcome ? outcome.refused : Object.keys(outcome.input).sort().join(","), log];
    };
    const PAGE = "page wiki/gadgets/g-1";
    expect(await run({}, { slug: "g-1", "spec-value": "x" })).toEqual(["caller input supplies host-owned page-evidence key \"spec-value\"", []]);
    expect(await run({}, {})).toEqual(["page-evidence input carries no target slug under slug", []]);
    expect(await run({})).toEqual(["page evidence requires an active profile", ["profile"]]);
    expect(await run({ loaded: GADGETS })).toEqual(["the targeted page gadgets/g-1 is absent", ["profile", PAGE]]);
    expect(await run({ loaded: GADGETS, spec: "torque" })).toEqual(["capture measured: gadgets/g-1 has 0 outgoing measures edges to widgets; exactly one is required", ["profile", PAGE, "relations"]]);
    expect(await run({ loaded: GADGETS, spec: "torque", edges: [EDGE] }))
      .toEqual(["measured-target,slug,spec-byte-count,spec-sha256,spec-value", ["profile", PAGE, "relations", "page wiki/widgets/w-1"]]);
  });

  it("P2 the runtime build re-runs every capture and refuses a drifted seal by its key", async () => {
    const log: string[] = [];
    const captured = await capturePageEvidenceInputFrom(pageReads([], { loaded: GADGETS, spec: "torque", edges: [EDGE] }), PAGE_PACK, "demo.run", { slug: "g-1" } as never);
    if (!("input" in captured)) throw new Error(captured.refused);
    const built = await buildPageEvidenceSpecsFrom(pageReads(log, { loaded: GADGETS, spec: "torque", edges: [EDGE] }), PAGE_DESCRIPTOR as never, captured.input);
    expect([built.status, log]).toEqual(["ok", ["profile", "page wiki/gadgets/g-1", "relations", "page wiki/widgets/w-1"]]);
    const drifted = await buildPageEvidenceSpecsFrom(pageReads([], { loaded: GADGETS, spec: "speed", edges: [EDGE] }), PAGE_DESCRIPTOR as never, captured.input);
    expect(drifted).toEqual({ status: "unavailable", reason: "page-evidence-drift: spec-value no longer matches its seal" });
  });

  it("P3 makes no ambient read from either body, while both root facades reach the profile loader with the root", async () => {
    const spy = vi.spyOn(profileBlock, "loadNonDefaultProfile");
    const answers = { loaded: GADGETS, spec: "torque", edges: [EDGE] };
    const captured = await capturePageEvidenceInputFrom(pageReads([], answers), PAGE_PACK, "demo.run", { slug: "g-1" } as never);
    await buildPageEvidenceSpecsFrom(pageReads([], answers), PAGE_DESCRIPTOR as never, ("input" in captured ? captured.input : {}) as never);
    expect(spy).not.toHaveBeenCalled();
    const root = await sourcesRoot();
    expect(await capturePageEvidenceInput(root, PAGE_PACK, "demo.run", { slug: "g-1" } as never)).toEqual({ refused: "page evidence requires an active profile" });
    expect(await buildPageEvidenceSpecs(root, PAGE_DESCRIPTOR as never, { slug: "g-1" })).toEqual({ status: "unavailable", reason: "page-evidence-no-profile" });
    expect(spy.mock.calls).toEqual([[root], [root]]);
  });
});
