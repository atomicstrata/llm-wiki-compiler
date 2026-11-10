/**
 * @file test/storage/artifact-apply-binding.test.ts
 * @description The single-body artifact write under the lock, whole:
 * `applyArtifactLockedWith` snapshots, loads the profile, plans, checks the
 * trusted-write grant, fixes the store coordinates, guards the targets, checks
 * applied-once (manifest identity, then the body), checks the audit store's
 * health and the event's size, journals BOTH targets and writes body then
 * manifest, commits, then appends the event (bound or not). The bound body
 * exists only after the handler was given sources, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once, and copied
 * BEFORE their disk ask: a fresh artifact project, one whose audit store is a
 * real base-version (v1) store with one record, and one with a tampered head.
 * On `fresh` and `tampered` the disk ask is the ROOT SDK `writeArtifact` (the
 * self-locking executor and its handler) with the REAL `LLMWIKI_TRUSTED_WRITE`
 * grant set or unset per step and restored in `finally`; the memory replay is
 * the bound executor with the BOUND artifact handler. On `v1` the disk ask is
 * the ROOT `applyArtifactLocked(root, m, binding)` as the bundle adapter calls
 * it — it does NOT take or exercise the caller's lock.
 *
 * ONE MEMORY MAP. The executor's replay, the journal, the artifact store reads
 * and the artifact writes share one map, so a failed write leaves a real pending
 * batch the next executor call's REAL replay restores.
 *
 * WHAT IS CHECKED PER SIDE. The artifact body's exact bytes, its manifest
 * (parsed; `writtenAt` hidden), the journal directory's entries, and the audit
 * store whole by the real reader (problems, chain, head sealing the last record,
 * strict). An interior bad event record throws; a bad last one is a tolerated
 * torn tail, reported and dropped. Minted event ids, `at`, `prevHash` and
 * `checksum` are hidden across sides.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The maps, the trace and the faults;
 * the grant member, a labelled STUB mirroring each disk step's grant (the real
 * grant semantics are `artifact-apply`, `cli-artifact` and `sdk-artifact`); the
 * target guard (a recorder); the writer (it stores the body and a JSON manifest,
 * not durably); and the member path, a recorder (binary custody is not
 * exercised). Nothing here shows the lock, real confinement, `lstat`, fsync,
 * power-loss durability, authorization or cross-store atomicity.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as applyGuards from "../../src/artifacts/apply-guards.js";
import { applyArtifactLocked, applyArtifactLockedWith, type ArtifactApplySources } from "../../src/artifacts/apply.js";
import type { ArtifactLeafReads } from "../../src/artifacts/resolve.js";
import * as artifactStore from "../../src/artifacts/store.js";
import * as eventRecord from "../../src/events/store-record.js";
import { createWiki } from "../../src/index.js";
import * as profileBlock from "../../src/profile/block.js";
import type { ProfilePack } from "../../src/profile/types.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts } from "../../src/trust/executor.js";
import type { ArtifactPlannedMutation } from "../../src/trust/planner.js";
import * as trustedWrite from "../../src/trust/trusted-write.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import * as markdown from "../../src/utils/markdown.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import {
  auditSeeds, boundOn, EVENTS, EVT_V1, expectBoundSilentRootReaches, expectCopiesHoldSeeds, freshBinding, health, HEALTHY, normalized, ONE, seededParity,
  shownEventLines, TWO, type AuditReads,
} from "./audit-event-fixtures.js";
import { effectiveProfileOf, unasked, type Copy } from "./copied-project.js";
import {
  diskJournalledReads, executorPorts, journalIo, keyOf, MEM_ROOT, memoryEvents, memorySideReads, put, type MemoryMap,
} from "./journal-memory-map.js";

const PREFIX = "artifact-apply-binding-";
const GRANT = "LLMWIKI_TRUSTED_WRITE";
const [DIR, BODY, MANIFEST] = [
  "artifacts/experiment-result/probe", "artifacts/experiment-result/probe/result.json", "artifacts/experiment-result/probe/result.json.manifest.json",
] as const;
const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "artifact-fixture", entities: { note: { directory: "wiki/notes" } },
  artifacts: {
    "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 65536, metadata: { accuracy: { type: "number", required: true } } },
    bundle: { fileName: "bundle.json", contentKind: "json", maxBytes: 65536, members: { maxCount: 4, maxMemberBytes: 4096, maxTotalBytes: 8192, allowedExtensions: [".tex", ".bin"] } },
  },
};
const [BODY_1, BODY_2] = [`{"accuracy":0.9}`, `{"accuracy":0.95}`] as const;
const SEEDS = auditSeeds({ ".llmwiki/profile.json": JSON.stringify(PROFILE) });
type Scenario = keyof typeof SEEDS;
const BINDING = freshBinding();
/** One write step: the SDK input and whether the grant is set for it. */
interface Step { artifactType: string; body: string; granted: boolean }
const step = (body: string, granted = true, artifactType = "experiment-result"): Step => ({ artifactType, body, granted });
const plannedOf = (s: Step): ArtifactPlannedMutation => ({ kind: "artifact", artifactType: s.artifactType, slug: "probe", body: s.body, origin: "sdk" });
const PLANS: Record<Scenario, Step[]> = {
  fresh: [step(BODY_1), step(BODY_1), step(BODY_2), step(BODY_1, false), step(BODY_1, true, "nope"), step(`{"accuracy":"high"}`)],
  v1: [step(BODY_1)],
  tampered: [step(BODY_1)],
};
/** The `v1` scenario is asked through the bundle's bound call on both sides; the rest through the SDK (disk) and the executor (memory). */
const { tracker, minted, parity } = seededParity({ prefix: PREFIX, seeds: SEEDS, plans: PLANS, run: runScenario, ...boundOn<Scenario, Side>("v1", diskSide, memorySide) });

/** Every read and act one side answers for. */
interface Side extends AuditReads {
  apply(s: Step): Promise<unknown>;
  journal(): Promise<string[]>;
}

/** The manifest as shown across sides: parsed, its `writtenAt` hidden. */
const shownManifest = (text: string | null): unknown => (text === null ? null : { ...(JSON.parse(text) as Record<string, unknown>), writtenAt: "<at>" });

/** Health, each step settled once, then the artifact, the journal, the events and health again. */
async function runScenario(side: Side, plan: Step[]): Promise<unknown> {
  const before = await health(side);
  const settled: unknown[] = [];
  for (const s of plan) settled.push(await side.apply(s).then((ref) => ref, (error: Error) => `${error.name}: ${error.message}`));
  const events = shownEventLines(await side.text(EVENTS));
  return normalized({ before, settled, body: await side.text(BODY), manifest: shownManifest(await side.text(MANIFEST)), journal: await side.journal(), events, after: await health(side) });
}

/** Run `act` with the REAL grant set (or unset), restoring the prior value in `finally`. */
async function withGrant<T>(granted: boolean, act: () => Promise<T>): Promise<T> {
  const prior = process.env[GRANT];
  if (granted) process.env[GRANT] = "*"; else delete process.env[GRANT];
  try { return await act(); } finally { if (prior === undefined) delete process.env[GRANT]; else process.env[GRANT] = prior; }
}

/** The ROOT surfaces over one disk project: the SDK action, or the bundle's direct bound call (no lock). */
function diskSide(root: string, bound: boolean): Side {
  return {
    apply: (s) => withGrant(s.granted, async () => (bound
      ? (await applyArtifactLocked(root, plannedOf(s), BINDING)).ref
      : (await createWiki({ root }).writeArtifact({ artifactType: s.artifactType, slug: "probe", body: s.body })).ref)),
    ...diskJournalledReads(root),
  };
}

/** The ONE memory map and its ordered log, plus the stub grant and a one-shot write fault. */
interface Memory extends MemoryMap { granted: boolean; failWrite: boolean; members: unknown[] }
/** The artifact's two confined leaf reads over the map, at the caps the body passes. */
function memoryLeaves(memory: Memory, relDir: string, fileName: string): ArtifactLeafReads {
  const [body, manifest] = [`${relDir}/${fileName}`, `${relDir}/${fileName}.manifest.json`];
  return {
    readManifestText: async (maxBytes) => {
      memory.log.push(`read-manifest ${manifest} max=${maxBytes}`);
      const text = memory.files.get(manifest);
      return text === undefined ? { kind: "absent" } : Buffer.byteLength(text) > maxBytes ? { kind: "unavailable" } : { kind: "ok", body: text };
    },
    readBodyText: async (maxBytes) => {
      memory.log.push(`read-body ${body} max=${maxBytes}`);
      const text = memory.files.get(body);
      return text === undefined ? { kind: "absent" } : Buffer.byteLength(text) > maxBytes ? { kind: "oversize", actualBytes: Buffer.byteLength(text) } : { kind: "ok", body: text };
    },
    listEntries: unasked("listEntries"),
    readMemberBytes: unasked("readMemberBytes"),
  };
}

/** The artifact sources over the same map: the REAL profile loader over the copy; a STUB grant; recorders for the guard, writer and members. */
function memorySources(memory: Memory, copy: Copy): ArtifactApplySources {
  return {
    root: MEM_ROOT,
    loadProfile: () => { memory.log.push("profile"); return profileBlock.loadNonDefaultProfileFrom(effectiveProfileOf(copy, () => undefined)); },
    trustedWrite: (profileId) => { memory.log.push(`grant ${profileId}`); return memory.granted; },
    applyMembers: async (write) => { memory.log.push("members"); memory.members.push(write); return { ref: { artifactType: write.mutation.artifactType, slug: write.mutation.slug, sha256: "0".repeat(64) }, decision: write.decision }; },
    guardTargets: async (expectedDir, targets) => { memory.log.push(`guard ${keyOf(expectedDir)} ${targets.length}`); },
    writeFiles: async (paths, body, manifest) => {
      memory.log.push(`write-files ${keyOf(paths.expectedDir)}`);
      put(memory, paths.bytesPath, body);
      put(memory, paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      if (memory.failWrite) { memory.failWrite = false; throw new Error("injected write failure"); }
    },
    store: { artifactAt: (type, slug, fileName) => memoryLeaves(memory, `artifacts/${type}/${slug}`, fileName) },
    journal: journalIo(memory),
    events: memoryEvents(memory),
  };
}

/** The memory side: the bound executor (replay first) with the bound artifact handler, or the body with the binding. */
function memorySide(copy: Copy, bound: boolean): Side & { memory: Memory; replay(): Promise<unknown> } {
  const memory: Memory = { files: new Map(copy.files), dirs: new Set(copy.listings.keys()), log: [], granted: true, failWrite: false, members: [] };
  const sources = memorySources(memory, copy);
  const ports = executorPorts(memory, { relation: unasked("relation"), lifecycle: unasked("lifecycle"), artifact: (_root, m) => applyArtifactLockedWith(sources, m) });
  const act = async (s: Step): Promise<unknown> => {
    memory.granted = s.granted;
    if (bound) return (await applyArtifactLockedWith(sources, plannedOf(s), BINDING)).ref;
    const [result] = await applyApprovedMutationsLockedFrom(ports, MEM_ROOT, [plannedOf(s)]);
    if (result?.kind !== "artifact") throw new Error("not an artifact result");
    return result.ref;
  };
  return { memory, apply: act, replay: () => applyApprovedMutationsLockedFrom(ports, MEM_ROOT, []), ...memorySideReads(memory) };
}

const ref = (body: string) => ({ artifactType: "experiment-result", slug: "probe", sha256: artifactStore.hashArtifactBody(body) });
const manifestOf = (body: string) => ({ ...ref(body), bytes: Buffer.byteLength(body, "utf8"), contentKind: "json", writtenAt: "<at>" });
const event = (n: number, body: string, binding?: OperationBinding) => ({
  id: `evt#${n}`, type: "artifact-write", origin: "sdk", decision: "allow",
  payload: { artifactType: "experiment-result", slug: "probe", sha256: artifactStore.hashArtifactBody(body), bytes: Buffer.byteLength(body, "utf8"), contentKind: "json" },
  ...(binding === undefined ? {} : { operationBinding: binding }), at: "<at>",
});
const EVT_HEADER_V1 = JSON.parse(EVT_V1) as unknown;

describe("the single-body artifact write under the lock, disk and memory, from three copied projects", () => {
  it("A1 runs after every minting directory was removed, on copies holding exactly their seeds", () => {
    expectCopiesHoldSeeds(minted, SEEDS, PREFIX);
  });

  it("A2/A3 writes, is applied-once on a re-write, rewrites a changed body, then refuses without the grant, for an undeclared type and for a body-contract violation, as the disk did", async () => {
    expect(await parity("fresh")).toEqual({
      before: HEALTHY,
      settled: [ref(BODY_1), ref(BODY_1), ref(BODY_2),
        `ArtifactWriteRefusedError: artifact write for "experiment-result" requires an out-of-band LLMWIKI_TRUSTED_WRITE grant`,
        expect.stringMatching(/^ArtifactWriteDeniedError: artifact write for "nope" was blocked \(decision: deny\): /u),
        expect.stringMatching(/^ArtifactWriteDeniedError: artifact write for "experiment-result" was blocked \(decision: /u)],
      body: BODY_2, manifest: manifestOf(BODY_2), journal: [],
      events: [EVT_HEADER_V1, event(1, BODY_1), event(2, BODY_2)], after: HEALTHY,
    });
  });

  it("A3 refuses a tampered audit head BEFORE any batch opens, with no artifact and the store unchanged, as the disk did", async () => {
    const tampered = { problems: [`head anchor ${"0".repeat(64)} does not match last event`], chainOk: true, headSealsLast: false, strict: "EventStoreChainError" };
    expect(await parity("tampered")).toEqual({
      before: tampered, settled: ["EventStoreChainError: event store chain broken: head anchor does not match a committable store state"],
      body: null, manifest: null, journal: [], events: [EVT_HEADER_V1, ONE, TWO], after: tampered,
    });
  });

  it("A4 raises a REAL v1 audit store to v2 through ONE durable call, keeping its record, then appends the bound event, as the disk did", async () => {
    expect(await parity("v1")).toEqual({
      before: HEALTHY, settled: [ref(BODY_1)], body: BODY_1, manifest: manifestOf(BODY_1), journal: [],
      events: [{ kind: "event-store-header", schemaVersion: 2 }, ONE, event(1, BODY_1, BINDING)], after: HEALTHY,
    });
    const side = memorySide(minted.v1.copy, true);
    await side.apply(step(BODY_1));
    expect(side.memory.log.filter((entry) => entry.startsWith("durable"))).toEqual(["durable events.jsonl"]);
  });
});

describe("the bound artifact write's order, its unknown outcomes, the member dispatch, and no ambient call (memory only, not real guards)", () => {
  const repair = ["read events.jsonl", "private-dir", "head events.head", "private-dir", "head events.head"];
  const batch = ".llmwiki/journal/<batch>.json";
  const record = (rel: string) => ["realpath .", `read ${rel}`, `replace ${batch}`];

  // Derived from source: this route has NO separate audit `prepare` before the pre-flight, so ONE repair precedes the size.
  it("A5 traces a first write exactly: replay, admission, guard, the manifest read only, the pre-flight's repair and size, both records, write, commit, then the event", async () => {
    const side = memorySide(minted.fresh.copy, false);
    await side.apply(step(BODY_1));
    expect(side.memory.log).toEqual([
      "safe-realpath .llmwiki/journal", "profile", "grant artifact-fixture", `guard ${DIR} 2`, `read-manifest ${MANIFEST} max=65536`,
      ...repair, "size events.jsonl", "confine .llmwiki/journal", `replace ${batch}`, ...record(BODY), ...record(MANIFEST),
      `write-files ${DIR}`, `remove ${batch}`, ...repair, "append events.jsonl at 0", "write events.jsonl", "write events.jsonl", "seal",
    ]);
    side.memory.log.length = 0;
    await side.apply(step(BODY_1));
    // Applied-once: the body is read ONLY because the manifest identity matched, and nothing is written.
    expect(side.memory.log.filter((entry) => /^read-(manifest|body)/u.test(entry))).toEqual([`read-manifest ${MANIFEST} max=65536`, `read-body ${BODY} max=65536`]);
    expect(side.memory.log.filter((entry) => /^(write-files|append|seal|durable|replace events)/u.test(entry))).toEqual([]);
  });

  it("A6 restores BOTH prior targets byte-exactly through the REAL replay after a write that landed both new targets and then failed", async () => {
    const side = memorySide(minted.fresh.copy, false);
    await side.apply(step(BODY_1));
    const prior = [side.memory.files.get(BODY), side.memory.files.get(MANIFEST), side.memory.files.get(EVENTS)];
    side.memory.failWrite = true;
    await expect(side.apply(step(BODY_2))).rejects.toThrow("injected write failure");
    expect([side.memory.files.get(BODY), (await side.journal()).length]).toEqual([BODY_2, 1]);
    await side.replay();
    expect([side.memory.files.get(BODY), side.memory.files.get(MANIFEST), side.memory.files.get(EVENTS), await side.journal()]).toEqual([...prior, []]);
  });

  it("A7 hands a member-bearing type to the root-bound member path exactly once, with the incumbent write object, and writes nothing itself", async () => {
    const side = memorySide(minted.fresh.copy, false);
    const memberFiles = [{ fileName: "main.tex", bytes: Buffer.from("\\documentclass{article}", "utf8") }];
    const [result] = await applyApprovedMutationsLockedFrom({ ...memoryPortsOf(side) }, MEM_ROOT, [{ kind: "artifact", artifactType: "bundle", slug: "probe", body: "", memberFiles, origin: "sdk" }]);
    const write = side.memory.members[0] as { root: string; paths: { relativeDir: string }; binding?: unknown; mutation: { memberFiles: Array<{ bytes: Uint8Array }> } };
    expect([result?.kind, side.memory.members.length, write.root, write.paths.relativeDir, write.binding, Buffer.from(write.mutation.memberFiles[0]!.bytes).equals(memberFiles[0]!.bytes), write.mutation.memberFiles[0]!.bytes === memberFiles[0]!.bytes])
      .toEqual(["artifact", 1, MEM_ROOT, "artifacts/bundle/probe", undefined, true, false]);
    expect(side.memory.log.filter((entry) => /^(guard|write-files|replace|append|seal)/u.test(entry))).toEqual([]);
  });

  it("A8 makes no ambient call in the bound route; the ROOT SDK write reaches each handler seam across modules", async () => {
    const atomic = vi.spyOn(markdown, "atomicWrite");
    const spies = [
      vi.spyOn(profileBlock, "loadNonDefaultProfile"), vi.spyOn(trustedWrite, "isTrustedWriteGranted"), vi.spyOn(applyGuards, "assertTargetsRegularOrAbsent"),
      vi.spyOn(artifactStore, "writeArtifactFiles"), atomic, vi.spyOn(confinedRead, "readConfinedLeaf"),
      vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(eventRecord, "openEventFileAppend"),
    ];
    const root = await expectBoundSilentRootReaches(spies, () => runScenario(memorySide(minted.fresh.copy, false), PLANS.fresh), { tracker, prefix: PREFIX, files: SEEDS.fresh },
      (at) => withGrant(true, () => createWiki({ root: at }).writeArtifact({ artifactType: "experiment-result", slug: "probe", body: BODY_1 })));
    // The durable artifact writes specifically (the seal also uses this writer, without `durable`).
    expect(atomic.mock.calls.some(([, , opts]) => opts?.durable === true && opts.confineRoot === root)).toBe(true);
  });
});

/** The bound executor ports of one memory side, with the bound artifact handler (for the member-dispatch case). */
function memoryPortsOf(side: ReturnType<typeof memorySide>): ApprovedMutationPorts {
  const sources = memorySources(side.memory, minted.fresh.copy);
  return executorPorts(side.memory, { relation: unasked("relation"), lifecycle: unasked("lifecycle"), artifact: (_root, m) => applyArtifactLockedWith(sources, m) });
}
