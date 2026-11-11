/**
 * @file test/storage/pack-authority-binding.test.ts
 * @description The pack authority resolver and the leg's evidence context as
 * ONE body each over their reads, `createPackAuthorityResolverFrom` and
 * `builtEvidenceContextFrom`, bound through `packAuthorityReadsOver` and
 * `packEvidenceBuildersOver`, with no project directory. This file uses them,
 * which exist only after each was given reads of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One real pack action is staged on disk, ONCE: its run
 * binding, its persisted manifest, each initial evidence object's verified read
 * and bytes, and the root resolver's answer for its host-handler phase are taken,
 * then the run is removed. Memory reads answer from those values and log every
 * call, so the resolver is required to answer as the disk did, and its ladders
 * (manifest, each initial input, the frozen action input, one evidence builder
 * per sealed descriptor), the reads each branch makes and the binding pinned at
 * construction are shown. The bound compositions and the root forms are shown
 * reaching their readers and builders with exact arguments.
 *
 * NOT SHOWN HERE: the evidence store, the manifest store and the spec builders
 * themselves; the preparation and evidence suites show those.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import type { AttemptAuthorityContextV1 } from "../../src/preparations/attempts/types.js";
import * as artifactEvidence from "../../src/operations-packs/runtime/artifact-evidence.js";
import {
  createPackAuthorityResolver, createPackAuthorityResolverFrom, packAuthorityReadsOver, packEvidenceBuildersOver,
  type PackAuthorityReads,
} from "../../src/operations-packs/runtime/authority-resolver.js";
import * as pageEvidence from "../../src/operations-packs/runtime/page-evidence.js";
import { builtEvidenceContextFrom } from "../../src/operations-packs/runtime/runner-input.js";
import * as sourceEvidence from "../../src/operations-packs/runtime/source-evidence.js";
import { compileSingleIntentAction, stageCompiledAction } from "../operations-packs/runtime-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

type Manifest = Awaited<ReturnType<typeof manifestStore.readPreparationManifest>>;
let BINDING: PreparationRunBinding, MANIFEST: Manifest, HOST: AttemptAuthorityContextV1, ON_DISK: unknown;
const EVIDENCE = new Map<string, unknown>(), BYTES = new Map<string, unknown>();

beforeAll(async () => {
  const run = await stageCompiledAction(await compileSingleIntentAction());
  try {
    BINDING = run.binding;
    MANIFEST = await manifestStore.readPreparationManifest(run.root, BINDING.workspaceId, BINDING.preparationId);
    if (MANIFEST.status !== "ok") throw new Error("the staged manifest did not read back");
    const location = { workspaceId: BINDING.workspaceId, preparationId: BINDING.preparationId };
    for (const ref of MANIFEST.manifest.initialEvidence) {
      const bare = ref.digest.replace(/^sha256:/, "");
      EVIDENCE.set(bare, await evidenceStore.readPreparationEvidence(run.root, location, bare));
      BYTES.set(bare, await evidenceStore.readPreparationEvidenceBytes(run.root, location, bare, 1 << 22));
    }
    const phase = run.action.plan.phases[0]!;
    HOST = { executor: phase.executor!, logicalPhaseId: phase.logicalPhaseId, phaseInstanceId: "phase-1" } as unknown as AttemptAuthorityContextV1;
    ON_DISK = await createPackAuthorityResolver({ root: run.root, binding: BINDING }).resolve(HOST);
  } finally {
    await run.cleanup();
  }
});

/** What the reads answer; anything left out answers as the disk did. */
interface World { manifest?: Manifest; evidence?: unknown; bytes?: unknown; built?: unknown }

/** Memory reads over `world`, each call logged (digests shortened to 8 characters). */
function readsOf(log: string[], world: World = {}): PackAuthorityReads {
  const short = (digest: string) => digest.slice(0, 8);
  const builder = (kind: string) => async (_descriptor: unknown, value: Readonly<Record<string, unknown>>) => {
    log.push(`${kind} ${JSON.stringify(value)}`);
    return (world.built ?? { status: "ok", built: { specs: [], pathTable: {} } }) as never;
  };
  return {
    readManifest: async (workspaceId, preparationId) => { log.push(`manifest ${workspaceId === BINDING.workspaceId && preparationId === BINDING.preparationId}`); return world.manifest ?? MANIFEST; },
    readEvidence: async (_location, digest) => { log.push(`evidence ${short(digest)}`); return (world.evidence ?? EVIDENCE.get(digest)) as never; },
    readEvidenceBytes: async (_location, digest) => { log.push(`bytes ${short(digest)}`); return (world.bytes ?? BYTES.get(digest)) as never; },
    source: builder("source"), artifact: builder("artifact"), page: builder("page"),
  };
}

/** A provider executor sealing `descriptors`. */
const provider = (descriptors: Record<string, unknown> = {}) =>
  ({ ...HOST, executor: { kind: "provider-capability", providerPinDigest: `sha256:${"7".repeat(64)}`, ...descriptors } }) as unknown as AttemptAuthorityContextV1;

/** Resolve `context` over `world`: the resolution (or its reason) and the log. */
async function resolveOver(context: AttemptAuthorityContextV1, world: World = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const resolved = await createPackAuthorityResolverFrom(readsOf(log, world), BINDING).resolve(context);
  return [resolved.status === "ok" ? resolved : resolved.reason, log];
}

const digests = () => (MANIFEST.status === "ok" ? MANIFEST.manifest.initialEvidence.map((ref) => ref.digest.replace(/^sha256:/, "").slice(0, 8)) : []);
const actionInput = () => (MANIFEST.status === "ok" ? MANIFEST.manifest.initialEvidence.find((ref) => ref.kind === "pack-action-input")!.digest.replace(/^sha256:/, "").slice(0, 8) : "");

describe("the authority resolver's one body over memory reads", () => {
  it("Q1 resolves a host-handler phase exactly as the disk did: the manifest, then each initial input in manifest order", async () => {
    expect(ON_DISK).toMatchObject({ status: "ok" });
    expect(await resolveOver(HOST)).toEqual([ON_DISK, ["manifest true", ...digests().map((digest) => `evidence ${digest}`)]]);
  });

  it("Q2 an unreadable manifest refuses before any input; the first unreadable input refuses and stops", async () => {
    expect(await resolveOver(HOST, { manifest: { status: "absent" } as Manifest })).toEqual(["manifest-absent", ["manifest true"]]);
    expect(await resolveOver(HOST, { evidence: { status: "corrupt" } })).toEqual(["initial-input-corrupt", ["manifest true", `evidence ${digests()[0]}`]]);
  });

  it("Q3 a provider phase sealing no evidence reads nothing; one sealing evidence reads the frozen input and runs exactly its builder", async () => {
    const [bare, log] = await resolveOver(provider());
    expect([bare, log]).toEqual([{ status: "ok", extras: { inputExposureSetDigest: expect.stringMatching(/^sha256:/), providerPinDigest: `sha256:${"7".repeat(64)}` } }, []]);
    for (const kind of ["source", "artifact", "page"]) {
      const [, built] = await resolveOver(provider({ [`${kind}EvidenceDescriptor`]: {} }));
      expect(built.map((line) => line.split(" ")[0])).toEqual(["manifest", "bytes", kind]);
    }
    expect((await resolveOver(provider({ sourceEvidenceDescriptor: {}, pageEvidenceDescriptor: {} })))[1].at(-1)).toMatch(/^source /);
  });

  it("Q4 refuses a frozen input that is unreadable, not a record or undecodable, and a builder refusal, each after its read", async () => {
    const source = provider({ sourceEvidenceDescriptor: {} });
    const pre = ["manifest true", `bytes ${actionInput()}`];
    expect(await resolveOver(source, { bytes: { status: "absent" } })).toEqual(["action-input-absent", pre]);
    expect(await resolveOver(source, { bytes: { status: "ok", bytes: Buffer.from("[]") } })).toEqual(["action-input-not-a-record", pre]);
    expect(await resolveOver(source, { bytes: { status: "ok", bytes: Buffer.from("{") } })).toEqual(["action-input-undecodable", pre]);
    expect((await resolveOver(source, { built: { status: "unavailable", reason: "source-evidence-drift" } }))[0]).toBe("source-evidence-drift");
    const noInput = { ...MANIFEST, manifest: { ...(MANIFEST as { manifest: object }).manifest, initialEvidence: [] } } as unknown as Manifest;
    expect(await resolveOver(source, { manifest: noInput })).toEqual(["action-input-evidence-missing", ["manifest true"]]);
  });

  it("Q5 the binding is copied at construction: a caller retargeting its object afterwards reads the original run", async () => {
    const log: string[] = [];
    const binding = { ...BINDING };
    const resolver = createPackAuthorityResolverFrom(readsOf(log), binding);
    Object.assign(binding, { workspaceId: "other", preparationId: "other" });
    await resolver.resolve(HOST);
    expect(log[0]).toBe("manifest true");
  });
});

describe("the leg's evidence context over its builders", () => {
  it("L1 builds one sealed kind (source before artifact before page) with its own path-table key, refuses with the builder's reason, and is absent with none", async () => {
    const log: string[] = [];
    const builders = readsOf(log, { built: { status: "ok", built: { specs: ["spec"], pathTable: { a: "b" } } } });
    const value = { topic: "t" };
    expect(await builtEvidenceContextFrom(builders, { artifactEvidenceDescriptor: { pathTableKey: "members" } } as never, value))
      .toEqual({ specs: ["spec"], pathTable: { a: "b" }, pathTableKey: "members" });
    await builtEvidenceContextFrom(builders, { sourceEvidenceDescriptor: { pathTableKey: "s" }, pageEvidenceDescriptor: { pathTableKey: "p" } } as never, value);
    expect(log).toEqual([`artifact ${JSON.stringify(value)}`, `source ${JSON.stringify(value)}`]);
    const refusing = readsOf([], { built: { status: "unavailable", reason: "page-evidence-slug-unsealed" } });
    expect(await builtEvidenceContextFrom(refusing, { pageEvidenceDescriptor: {} } as never, value)).toBe("page-evidence-slug-unsealed");
    expect(await builtEvidenceContextFrom(refusing, {} as never, value)).toBeUndefined();
  });
});

describe("the bound compositions and the root forms", () => {
  it("B1 the compositions reach every lower body over its own seam", async () => {
    const seams = { manifests: {} as never, evidence: {} as never, sourceLeaves: {} as never, artifacts: {} as never, pages: {} as never };
    const ok = { status: "ok", built: { specs: [], pathTable: {} } } as never;
    const spies = [
      vi.spyOn(manifestStore, "readPreparationManifestFrom").mockResolvedValue(MANIFEST),
      vi.spyOn(evidenceStore, "readPreparationEvidenceBytesFrom").mockImplementation(async (_r, _l, digest) => BYTES.get(digest) as never),
      vi.spyOn(sourceEvidence, "buildSourceEvidenceSpecsFrom").mockResolvedValue(ok),
      vi.spyOn(artifactEvidence, "buildArtifactEvidenceSpecsFrom").mockResolvedValue(ok),
      vi.spyOn(pageEvidence, "buildPageEvidenceSpecsFrom").mockResolvedValue(ok),
    ];
    const reads = packAuthorityReadsOver({ manifests: seams.manifests, evidence: seams.evidence, builders: packEvidenceBuildersOver(seams) });
    for (const kind of ["source", "artifact", "page"]) await createPackAuthorityResolverFrom(reads, BINDING).resolve(provider({ [`${kind}EvidenceDescriptor`]: {} }));
    expect(spies.map((spy) => spy.mock.calls.map((call) => call[0]))).toEqual([
      Array(3).fill(seams.manifests), Array(3).fill(seams.evidence), [seams.sourceLeaves], [seams.artifacts], [seams.pages],
    ]);
    const evidence = vi.spyOn(evidenceStore, "readPreparationEvidenceFrom").mockImplementation(async (_r, _l, digest) => EVIDENCE.get(digest) as never);
    expect(await createPackAuthorityResolverFrom(reads, BINDING).resolve(HOST)).toEqual(ON_DISK);
    expect(evidence.mock.calls.map((call) => call[0])).toEqual(digests().map(() => seams.evidence));
  });

  it("B2 the root form reaches every incumbent root reader and builder with the root and the run's own location", async () => {
    const location = { workspaceId: BINDING.workspaceId, preparationId: BINDING.preparationId };
    const manifest = vi.spyOn(manifestStore, "readPreparationManifest").mockResolvedValue(MANIFEST);
    const evidence = vi.spyOn(evidenceStore, "readPreparationEvidence").mockImplementation(async (_root, _l, digest) => EVIDENCE.get(digest) as never);
    const bytes = vi.spyOn(evidenceStore, "readPreparationEvidenceBytes").mockImplementation(async (_root, _l, digest) => BYTES.get(digest) as never);
    const source = vi.spyOn(sourceEvidence, "buildSourceEvidenceSpecs").mockResolvedValue({ status: "ok", built: { specs: [], pathTable: {} } } as never);
    const resolver = createPackAuthorityResolver({ root: "/project", binding: BINDING });
    expect(await resolver.resolve(HOST)).toEqual(ON_DISK);
    await resolver.resolve(provider({ sourceEvidenceDescriptor: { pathTableKey: "s" } }));
    expect(manifest.mock.calls).toEqual(Array(2).fill(["/project", BINDING.workspaceId, BINDING.preparationId]));
    expect(evidence.mock.calls.map((call) => call.slice(0, 2))).toEqual(digests().map(() => ["/project", location]));
    expect([bytes.mock.calls[0]?.slice(0, 2), source.mock.calls[0]?.slice(0, 2)]).toEqual([["/project", location], ["/project", { pathTableKey: "s" }]]);
  });
});
