/**
 * @file test/storage/artifact-members-binding.test.ts
 * @description The member-bearing (binary) artifact write under the lock,
 * whole: `applyMembersLockedWith` guards every target, checks applied-once by
 * the resolver (manifest, every member, the exact directory), lists obsolete
 * leaves, pre-flights the event, journals the manifest pair as text and every
 * incoming and obsolete member as base64, writes members then the manifest
 * pair, unlinks obsolete leaves, commits, re-resolves (refusing a divergence
 * before any event), then appends the event. The bound body exists only after
 * the member write was given sources, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once: `fresh`; `prior`,
 * holding a bundle written by the REAL SDK with one text and two NON-UTF-8
 * members; and `stale`, the same with one member's bytes then altered on disk.
 * Each is copied RAW (a local byte copy: `readFile` with no encoding, checked
 * against the seed bytes with `Buffer.equals`) BEFORE its disk ask, which is the
 * ROOT SDK `writeArtifact` with the REAL grant. The memory replay is the bound
 * executor with the bound artifact handler, whose member path is the bound body.
 *
 * ONE BYTE MAP. A `Map<string, Buffer>` serves the executor's replay, the
 * journal (text and binary pre-states), the artifact store reads and the
 * writes. Member leaves are compared by `Buffer.equals` or their sha256 and are
 * never decoded as text; every stored and returned value is an owned copy.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The map, the trace, the faults (an
 * unlink that throws after deleting; a member write that "folds" a name), the
 * grant (a STUB) and the guard (a recorder). Nothing here shows the lock,
 * authorization, real confinement or `lstat`, fsync, power-loss durability, a
 * real filesystem's case folding, or cross-store atomicity.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { applyArtifactLockedWith, type ArtifactApplySources } from "../../src/artifacts/apply.js";
import * as applyGuards from "../../src/artifacts/apply-guards.js";
import { applyMembersLockedWith, type MembersApplySources } from "../../src/artifacts/apply-members.js";
import type { ArtifactLeafReads, ArtifactStoreReads } from "../../src/artifacts/resolve.js";
import * as artifactStore from "../../src/artifacts/store.js";
import type { EventBoundWriteSources } from "../../src/events/store.js";
import { readEvents, readEventsFrom, verifyEventChain } from "../../src/events/store-read.js";
import * as eventRecord from "../../src/events/store-record.js";
import type { EventRecord } from "../../src/events/types.js";
import { createWiki } from "../../src/sdk/wiki.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import * as profileBlock from "../../src/profile/block.js";
import type { ProfilePack } from "../../src/profile/types.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts } from "../../src/trust/executor.js";
import type { ArtifactPlannedMutation } from "../../src/trust/planner.js";
import type { GraphAppendPlan } from "../../src/utils/jsonl-store.js";
import * as markdown from "../../src/utils/markdown.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import * as pathConfine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { normalized } from "./audit-event-fixtures.js";
import { effectiveProfileOf, enoent, mintOnceThenRemove, unasked, writeFiles, type Copy } from "./copied-project.js";
import { keyOf, MEM_ROOT, memoryPathChecks, shownKey } from "./journal-memory-map.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "artifact-members-binding-";
const GRANT = "LLMWIKI_TRUSTED_WRITE";
const [DIR, BODY, MANIFEST, EVENTS, HEAD, JOURNAL] = [
  "artifacts/bundle/probe", "artifacts/bundle/probe/bundle.json", "artifacts/bundle/probe/bundle.json.manifest.json",
  "wiki/graph/events.jsonl", ".llmwiki/events.head", ".llmwiki/journal",
] as const;
const PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "members-fixture", entities: { note: { directory: "wiki/notes" } },
  artifacts: { bundle: { fileName: "bundle.json", contentKind: "json", maxBytes: 65536, members: { maxCount: 4, maxMemberBytes: 4096, maxTotalBytes: 8192, allowedExtensions: [".tex", ".bin"] } } },
};
const PROFILE_TEXT = JSON.stringify(PROFILE);
/** The profile alone, as the REAL effective-profile loader reads it (the map holds bytes; the loader reads text). */
const PROFILE_COPY: Copy = { files: new Map([[".llmwiki/profile.json", PROFILE_TEXT]]), listings: new Map() };
const [TEX, TEX_2] = [Buffer.from("\\documentclass{article}", "utf8"), Buffer.from("\\documentclass{book}", "utf8")] as const;
/** Deliberately invalid UTF-8: a text round trip would corrupt each. */
const [BIN_A, BIN_B, BIN_C, BIN_D] = [
  Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]), Buffer.from([0xc0, 0xaf, 0xfe, 0xff, 0x00, 0x7f]), Buffer.from([0xed, 0xa0, 0x80, 0xf8, 0x88, 0x80]), Buffer.from([0x80, 0x81, 0xfe, 0xc1]),
] as const;
interface Member { fileName: string; bytes: Buffer }
const m = (fileName: string, bytes: Buffer): Member => ({ fileName, bytes });
const PRIOR_SET = [m("main.tex", TEX), m("data.bin", BIN_A), m("figure.bin", BIN_B)];
const WRITE_SET = [m("main.tex", TEX), m("figure.bin", BIN_B)];
const BUNDLE = mintBundleId();
const BINDING: OperationBinding = { bundleId: BUNDLE, runId: mintOperationRunId(), mutationId: mutationId(BUNDLE, 0) };
const planned = (members: Member[]): ArtifactPlannedMutation => ({
  kind: "artifact", artifactType: "bundle", slug: "probe", body: "", memberFiles: members.map((x) => ({ fileName: x.fileName, bytes: Uint8Array.from(x.bytes) })), origin: "sdk",
});
const SCENARIOS = {
  fresh: [WRITE_SET, WRITE_SET, [m("main.tex", TEX)]],
  prior: [[m("MAIN.tex", TEX), m("data.bin", BIN_A), m("figure.bin", BIN_B)]],
  stale: [PRIOR_SET],
};
type Scenario = keyof typeof SCENARIOS;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Run `act` with the REAL grant set, restoring the prior value in `finally`. */
async function granted<T>(act: () => Promise<T>): Promise<T> {
  const prior = process.env[GRANT];
  process.env[GRANT] = "*";
  try { return await act(); } finally { if (prior === undefined) delete process.env[GRANT]; else process.env[GRANT] = prior; }
}
const sdkWrite = (root: string, members: Member[]) => granted(() => createWiki({ root }).writeArtifact({ artifactType: "bundle", slug: "probe", memberFiles: members }));

/** A raw byte copy of a project tree: every file as an owned `Buffer` (NO encoding), every directory. */
interface RawCopy { files: Map<string, Buffer>; dirs: Set<string> }
async function rawCopy(root: string, rel = "", copy: RawCopy = { files: new Map(), dirs: new Set([""]) }): Promise<RawCopy> {
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) { copy.dirs.add(child); await rawCopy(root, child, copy); } else if (entry.isFile()) copy.files.set(child, await readFile(path.join(root, child)));
  }
  return copy;
}

/** Every side answers these. */
interface Side {
  apply(members: Member[]): Promise<unknown>;
  bytes(rel: string): Promise<Buffer | null>;
  list(rel: string): Promise<string[]>;
  events(): Promise<{ events: EventRecord[]; problems: string[] }>;
}

/** The artifact directory as shown: each leaf's sha256 (binary-safe), the manifest parsed with `writtenAt` hidden. */
async function shownLeaves(side: Side): Promise<Record<string, unknown>> {
  const shown: Record<string, unknown> = {};
  for (const name of (await side.list(DIR)).sort()) {
    const bytes = (await side.bytes(`${DIR}/${name}`))!;
    shown[name] = name.endsWith(".manifest.json") ? { ...(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>), writtenAt: "<at>" } : sha(bytes);
  }
  return shown;
}

/** Each step settled once, then the artifact directory, the journal, the events (types, origins, payloads) and their chain health. */
async function runScenario(side: Side, steps: Member[][]): Promise<unknown> {
  const settled: unknown[] = [];
  for (const members of steps) settled.push(await side.apply(members).then((ref) => ref, (error: Error) => `${error.name}: ${error.message}`));
  const { events, problems } = await side.events();
  const shownEvents = events.map(({ type, origin, payload, decision }) => ({ type, origin, payload, decision }));
  return normalized({ settled, leaves: await shownLeaves(side), journal: await side.list(JOURNAL), events: shownEvents, problems, chainOk: verifyEventChain(events).ok });
}

/** The ROOT SDK surface over one disk project. */
function diskSide(root: string): Side {
  return {
    apply: async (members) => (await sdkWrite(root, members)).ref,
    bytes: (rel) => readFile(path.join(root, rel)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }),
    list: (rel) => readdir(path.join(root, rel)).catch(() => []),
    events: () => readEvents(root),
  };
}

const tracker = tempRootTracker();
const minted = {} as Record<Scenario, { dir: string; onDisk: unknown; copy: RawCopy }>;
/** Seed, copy RAW (checked against the seed's bytes), then ask the disk. */
async function mint(name: Scenario): Promise<void> {
  const dir = await tracker.create(PREFIX);
  await writeFiles(dir, { ".llmwiki/profile.json": PROFILE_TEXT });
  if (name !== "fresh") await sdkWrite(dir, PRIOR_SET);
  if (name === "stale") await writeFile(path.join(dir, DIR, "figure.bin"), BIN_C);
  const copy = await rawCopy(dir);
  const expected = name === "fresh" ? null : name === "stale" ? BIN_C : BIN_B;
  if (expected !== null && !(copy.files.get(`${DIR}/figure.bin`)?.equals(expected) && copy.files.get(`${DIR}/data.bin`)?.equals(BIN_A))) throw new Error(`raw copy of ${name} is not byte-exact`);
  minted[name] = { dir, copy, onDisk: await runScenario(diskSide(dir), SCENARIOS[name]) };
}
mintOnceThenRemove(tracker, async () => { for (const name of Object.keys(SCENARIOS) as Scenario[]) await mint(name); });

/** The ONE byte map, the ordered log and the one-shot faults. */
interface Memory { files: Map<string, Buffer>; dirs: Set<string>; log: string[]; faults: { unlinkThenThrow?: boolean; foldSecond?: boolean }; writes: number }
function put(memory: Memory, rel: string, bytes: Uint8Array | string): void {
  memory.files.set(rel, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes));
  for (let dir = path.posix.dirname(rel); dir !== "."; dir = path.posix.dirname(dir)) memory.dirs.add(dir);
}
const textOf = (memory: Memory, rel: string): string | undefined => memory.files.get(rel)?.toString("utf8");

/** The journal and replay I/O over the map; text members decode, binary members stay owned `Buffer` copies. */
function memoryIo(memory: Memory): ApprovedMutationPorts["journal"] & ApprovedMutationPorts["page"] {
  const capped = <T>(rel: string, maxBytes: number, ok: (b: Buffer) => T) => {
    const held = memory.files.get(rel);
    return held === undefined ? { kind: "absent" as const } : held.byteLength > maxBytes ? { kind: "unavailable" as const } : ok(held);
  };
  return {
    ...memoryPathChecks(memory),
    leafPresent: async (dir, name) => memory.files.has(keyOf(path.join(dir, name))),
    readConfinedLeafText: async (_root: string, leaf: string, _dir: string, maxBytes: number) => { memory.log.push(`read ${shownKey(leaf)}`); return capped(keyOf(leaf), maxBytes, (b) => ({ kind: "ok" as const, body: b.toString("utf8") })); },
    readConfinedLeafBytes: async (_root: string, leaf: string, _dir: string, maxBytes: number) => { memory.log.push(`read-bytes ${shownKey(leaf)}`); return capped(keyOf(leaf), maxBytes, (b) => ({ kind: "ok" as const, body: Buffer.from(b) })); },
    readLeafTextNoFollow: async (leaf) => { memory.log.push(`read-nofollow ${shownKey(leaf)}`); return textOf(memory, keyOf(leaf)) ?? null; },
    replaceLeafAtomicWithin: async (_root, leaf, text) => { memory.log.push(`replace ${shownKey(leaf)}`); put(memory, keyOf(leaf), text); },
    replaceLeafContentWithin: async (_root, leaf, content) => { memory.log.push(`restore ${shownKey(leaf)}`); put(memory, keyOf(leaf), content); },
    removeLeaf: async (leaf) => { memory.log.push(`remove ${shownKey(leaf)}`); if (!memory.files.delete(keyOf(leaf))) throw enoent(); },
    listDirectoryNames: async (dir) => { memory.log.push(`list ${shownKey(dir)}`); const prefix = `${keyOf(dir)}/`; return [...new Set([...memory.files.keys()].filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length).split("/")[0]!))]; },
    makeDirectoryTree: async (dir) => { memory.dirs.add(keyOf(dir)); },
    renameLeafUnguarded: async (from, to) => { put(memory, keyOf(to), memory.files.get(keyOf(from))!); memory.files.delete(keyOf(from)); },
  };
}

/** The artifact's leaf reads over the map: the manifest and body as text, members as owned `Buffer` copies, the directory's direct entries. */
function memoryStore(memory: Memory): ArtifactStoreReads {
  return { artifactAt: (type, slug, fileName): ArtifactLeafReads => {
    const dir = `artifacts/${type}/${slug}`;
    return {
      readManifestText: async (maxBytes) => { memory.log.push(`read-manifest ${dir}`); const t = textOf(memory, `${dir}/${fileName}.manifest.json`); return t === undefined ? { kind: "absent" } : Buffer.byteLength(t) > maxBytes ? { kind: "unavailable" } : { kind: "ok", body: t }; },
      readBodyText: async (maxBytes) => { memory.log.push(`read-body ${dir}`); const t = textOf(memory, `${dir}/${fileName}`); return t === undefined ? { kind: "absent" } : Buffer.byteLength(t) > maxBytes ? { kind: "oversize", actualBytes: Buffer.byteLength(t) } : { kind: "ok", body: t }; },
      listEntries: async () => {
        memory.log.push(`list-entries ${dir}`);
        if (!memory.dirs.has(dir)) return { kind: "absent" };
        return { kind: "ok", entries: [...memory.files.keys()].filter((rel) => path.posix.dirname(rel) === dir).map((rel) => ({ name: path.posix.basename(rel), kind: "file" as const })) };
      },
      readMemberBytes: async (name, maxBytes) => { memory.log.push(`read-member ${name}`); const b = memory.files.get(`${dir}/${name}`); return b === undefined ? { kind: "absent" } : b.byteLength > maxBytes ? { kind: "oversize", actualBytes: b.byteLength } : { kind: "ok", body: Buffer.from(b) }; },
    };
  } };
}

/** The audit store's bound-append sources over the map (the event store is text). */
function memoryEvents(memory: Memory): EventBoundWriteSources {
  const append = async (plan: GraphAppendPlan): Promise<void> => {
    const existing = memory.files.get(EVENTS)?.byteLength ?? 0;
    memory.log.push(`append events.jsonl at ${existing}`);
    for (const chunk of plan(existing)) { memory.log.push("write events.jsonl"); put(memory, EVENTS, (textOf(memory, EVENTS) ?? "") + chunk); }
  };
  return {
    graph: { readStore: async (config) => { memory.log.push(`read ${config.fileName}`); return textOf(memory, `wiki/graph/${config.fileName}`) ?? null; } },
    resolvePrivateDir: async () => { memory.log.push("private-dir"); return memory.dirs.has(".llmwiki") ? ".llmwiki" : null; },
    readHeadLeaf: async (dir, name) => { memory.log.push(`head ${name}`); const t = textOf(memory, `${dir}/${name}`); return t === undefined ? { kind: "absent" } : { kind: "text", text: t }; },
    replaceStore: async (body) => { memory.log.push("replace events.jsonl"); put(memory, EVENTS, body); },
    appendStore: append,
    storeByteSize: async () => { memory.log.push("size events.jsonl"); return memory.files.get(EVENTS)?.byteLength ?? 0; },
    sealHead: async (digest) => { memory.log.push("seal"); put(memory, HEAD, digest); },
    replaceStoreDurable: async (body) => { memory.log.push("durable events.jsonl"); put(memory, EVENTS, body); },
  };
}

/** The member sources over the map: a recorder guard, the writers and the unlink, each with its labelled fault. */
function memoryMemberSources(memory: Memory): MembersApplySources {
  return {
    guardTargets: async (expectedDir, targets) => { memory.log.push(`guard ${keyOf(expectedDir)} ${targets.length}`); },
    writeMember: async (leafPath, bytes) => {
      const name = path.posix.basename(keyOf(leafPath));
      memory.log.push(`write-member ${name}`);
      memory.writes += 1;
      const folded = memory.faults.foldSecond === true && memory.writes === 2 ? name.toUpperCase() : name; // a simulated filesystem fold
      put(memory, `${path.posix.dirname(keyOf(leafPath))}/${folded}`, bytes);
    },
    writeFiles: async (paths, body, manifest) => { memory.log.push(`write-files ${keyOf(paths.expectedDir)}`); put(memory, keyOf(paths.bytesPath), body); put(memory, keyOf(paths.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`); },
    unlinkObsolete: async (relativeDir, name) => {
      memory.log.push(`unlink ${name}`);
      memory.files.delete(`${relativeDir}/${name}`);
      if (memory.faults.unlinkThenThrow === true) { memory.faults.unlinkThenThrow = false; throw new Error("injected unlink failure"); }
    },
    store: memoryStore(memory), journal: memoryIo(memory), events: memoryEvents(memory),
  };
}

/** The memory side: the bound executor (replay first), its artifact handler's member path being the bound body. */
function memorySide(name: Scenario, faults: Memory["faults"] = {}) {
  const copy = minted[name].copy;
  const memory: Memory = { files: new Map([...copy.files].map(([rel, b]) => [rel, Buffer.from(b)])), dirs: new Set(copy.dirs), log: [], faults, writes: 0 };
  const members = memoryMemberSources(memory);
  // The executor's journal and page ports need the WHOLE replay I/O; `members.journal` is typed as the batch I/O only. Same map, stateless.
  const io = memoryIo(memory);
  const artifact: ArtifactApplySources = {
    root: MEM_ROOT, store: members.store, journal: members.journal, events: members.events,
    loadProfile: () => { memory.log.push("profile"); return profileBlock.loadNonDefaultProfileFrom(effectiveProfileOf(PROFILE_COPY, () => undefined)); },
    trustedWrite: (profileId) => { memory.log.push(`grant ${profileId}`); return true; },
    applyMembers: (write) => applyMembersLockedWith(members, write),
    guardTargets: unasked("guardTargets"), writeFiles: unasked("writeFiles"),
  };
  const ports: ApprovedMutationPorts = { journal: io, page: io, writeOne: unasked("writeOne"), notes: unasked("notes"),
    handlers: { relation: unasked("relation"), lifecycle: unasked("lifecycle"), artifact: (_root, mutation) => applyArtifactLockedWith(artifact, mutation) } };
  const side: Side = {
    apply: async (set) => { const [result] = await applyApprovedMutationsLockedFrom(ports, MEM_ROOT, [planned(set)]); if (result?.kind !== "artifact") throw new Error("not an artifact result"); return result.ref; },
    bytes: async (rel) => (memory.files.has(rel) ? Buffer.from(memory.files.get(rel)!) : null),
    list: async (rel) => [...memory.files.keys()].filter((key) => path.posix.dirname(key) === rel).map((key) => path.posix.basename(key)),
    events: () => readEventsFrom(memoryEvents({ ...memory, log: [] })),
  };
  return { side, memory, artifact, replay: () => applyApprovedMutationsLockedFrom(ports, MEM_ROOT, []) };
}

const parity = async (name: Scenario): Promise<unknown> => {
  const onMemory = await runScenario(memorySide(name).side, SCENARIOS[name]);
  expect(onMemory).toEqual(minted[name].onDisk);
  return onMemory;
};
const leafShas = (members: Member[]) => Object.fromEntries(members.map((x) => [x.fileName, sha(x.bytes)]));
const keysOf = (shown: unknown) => Object.keys((shown as { leaves: Record<string, unknown> }).leaves).sort();

describe("the member-bearing artifact write, disk and memory, from three raw-copied projects", () => {
  it("B1 runs after every minting directory was removed, on raw copies whose non-UTF-8 members are byte-exact", () => {
    for (const name of Object.keys(SCENARIOS) as Scenario[]) expectMintingDirectoryRemoved(minted[name].dir, PREFIX);
    expect([minted.prior.copy.files.get(`${DIR}/figure.bin`)!.equals(BIN_B), minted.prior.copy.files.get(`${DIR}/data.bin`)!.equals(BIN_A), minted.stale.copy.files.get(`${DIR}/figure.bin`)!.equals(BIN_C)]).toEqual([true, true, true]);
  });

  it("B2 writes, is applied-once on the same set, then shrinks (the obsolete binary journalled and unlinked), as the disk did", async () => {
    const shown = await parity("fresh") as { settled: unknown[]; leaves: Record<string, unknown>; journal: string[]; events: Array<{ type: string }>; problems: string[]; chainOk: boolean };
    expect(shown.settled[1]).toEqual(shown.settled[0]);
    expect(shown.settled[2]).not.toEqual(shown.settled[0]);
    expect([keysOf(shown), shown.leaves["main.tex"], shown.journal, shown.events.map((e) => e.type), shown.problems, shown.chainOk])
      .toEqual([["bundle.json", "bundle.json.manifest.json", "main.tex"], sha(TEX), [], ["artifact-write", "artifact-write"], [], true]);
  });

  it("B3 refuses a case-only rename as an alias collision BEFORE any write, the directory and events unchanged, as the disk did", async () => {
    const shown = await parity("prior") as { settled: unknown[]; leaves: Record<string, unknown>; events: unknown[] };
    expect(shown.settled).toEqual([`ArtifactMemberAliasCollisionError: existing member leaf "main.tex" alias-collides with new member "MAIN.tex"; remove the old leaf before a case/normalization-only rename`]);
    expect([shown.leaves["data.bin"], shown.leaves["figure.bin"], shown.events.length]).toEqual([sha(BIN_A), sha(BIN_B), 1]);
  });

  it("B8 rewrites (repairs) a stale member instead of calling the set applied-once, as the disk did", async () => {
    const shown = await parity("stale") as { leaves: Record<string, unknown>; events: unknown[] };
    expect([shown.leaves["figure.bin"], shown.leaves["data.bin"], shown.leaves["main.tex"], shown.events.length]).toEqual([...Object.values(leafShas([m("figure.bin", BIN_B), m("data.bin", BIN_A), m("main.tex", TEX)])), 2]);
  });
});

describe("the bound member write's unknown outcomes, its order, and no ambient call (memory only, not real guards)", () => {
  const repair = ["read events.jsonl", "private-dir", "head events.head"];
  const batch = ".llmwiki/journal/<batch>.json";
  const record = (rel: string, read = "read") => ["realpath .", `${read} ${rel}`, `replace ${batch}`];

  it("B4 restores EVERY prior byte through the REAL replay after a fault that struck AFTER the obsolete binary was removed", async () => {
    const { side, memory, replay } = memorySide("prior", { unlinkThenThrow: true });
    const prior = new Map([...memory.files].filter(([rel]) => rel.startsWith(`${DIR}/`)).map(([rel, b]) => [rel, Buffer.from(b)]));
    const events = Buffer.from(memory.files.get(EVENTS)!);
    await expect(side.apply([m("main.tex", TEX_2), m("data.bin", BIN_C), m("new.bin", BIN_D)])).rejects.toThrow("injected unlink failure");
    expect([memory.files.has(`${DIR}/figure.bin`), memory.files.get(`${DIR}/new.bin`)?.equals(BIN_D), memory.files.get(`${DIR}/data.bin`)?.equals(BIN_C), memory.files.get(BODY)?.equals(prior.get(BODY)!), (await side.list(JOURNAL)).length])
      .toEqual([false, true, true, false, 1]);
    await replay();
    const now = [...memory.files.keys()].filter((rel) => rel.startsWith(`${DIR}/`)).sort();
    expect([now, [...prior].every(([rel, b]) => memory.files.get(rel)!.equals(b)), await side.list(JOURNAL), memory.files.get(EVENTS)!.equals(events)])
      .toEqual([[...prior.keys()].sort(), true, [], true]);
  });

  it("B5 refuses a post-commit divergence (a simulated name fold) with the resolver's exact health, BEFORE any event", async () => {
    const { side, memory } = memorySide("fresh", { foldSecond: true });
    const error = await side.apply(WRITE_SET).then(() => null, (caught: Error) => caught);
    expect([error?.name, error?.message]).toEqual(["ArtifactMembersDivergedError",
      `member-bearing artifact "probe" does not resolve after its own commit (health: artifact-bytes-tampered); the filesystem folded or altered a landed leaf — the write is refused, not reported as success`]);
    // The batch had committed (the journal is gone); the folded leaf is what the resolver's sweep refused; no event was appended.
    expect([memory.files.has(EVENTS), await side.list(JOURNAL), memory.files.has(`${DIR}/FIGURE.BIN`), memory.files.has(`${DIR}/figure.bin`)]).toEqual([false, [], true, false]);
  });

  it("B6 traces a first write exactly; zero durable EVENT-HEADER calls unbound; one bound write carries its binding", async () => {
    const { side, memory } = memorySide("fresh");
    await side.apply(WRITE_SET);
    expect(memory.log).toEqual([
      "safe-realpath .llmwiki/journal", "profile", "grant members-fixture", `guard ${DIR} 4`, `read-manifest ${DIR}`, `read-body ${DIR}`, `list-entries ${DIR}`,
      ...repair, "size events.jsonl", "confine .llmwiki/journal", `replace ${batch}`, ...record(BODY), ...record(MANIFEST),
      ...record(`${DIR}/main.tex`, "read-bytes"), ...record(`${DIR}/figure.bin`, "read-bytes"), "write-member main.tex", "write-member figure.bin", `write-files ${DIR}`,
      `remove ${batch}`, `read-manifest ${DIR}`, `read-body ${DIR}`, `list-entries ${DIR}`, "read-member figure.bin", "read-member main.tex",
      ...repair, "append events.jsonl at 0", "write events.jsonl", "write events.jsonl", "seal",
    ]);
    expect(memory.log.filter((entry) => entry === "durable events.jsonl")).toEqual([]);
    const bound = memorySide("fresh");
    await applyArtifactLockedWith(bound.artifact, planned(WRITE_SET), BINDING);
    expect((await bound.side.events()).events.at(-1)?.operationBinding).toEqual(BINDING);
  });

  it("B7 makes no ambient call in the bound route; the ROOT SDK shrink reaches each physical seam across modules, and its unlink by effect", async () => {
    const root = await tracker.create(PREFIX);
    await writeFiles(root, { ".llmwiki/profile.json": PROFILE_TEXT });
    await sdkWrite(root, PRIOR_SET);
    const atomic = vi.spyOn(markdown, "atomicWrite");
    const confine = vi.spyOn(pathConfine, "confineUnderRoot");
    const spies = [vi.spyOn(artifactStore, "writeArtifactMember"), vi.spyOn(artifactStore, "writeArtifactFiles"), atomic, vi.spyOn(applyGuards, "assertTargetsRegularOrAbsent"),
      vi.spyOn(diskLeaves, "readConfinedLeafBytes"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(eventRecord, "openEventFileAppend"), confine];
    await memorySide("prior").side.apply([m("main.tex", TEX)]);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    await sdkWrite(root, [m("main.tex", TEX)]);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
    expect(atomic.mock.calls.some(([file, content, opts]) => String(file).endsWith(`${path.sep}main.tex`) && content instanceof Uint8Array && opts?.durable === true && opts.confineRoot === root)).toBe(true);
    expect(confine.mock.calls.some(([rel, at, opts]) => rel === `${DIR}/figure.bin` && at === root && opts?.mustExist === false)).toBe(true);
    expect([(await readdir(path.join(root, DIR))).sort()]).toEqual([["bundle.json", "bundle.json.manifest.json", "main.tex"]]);
  });
});
