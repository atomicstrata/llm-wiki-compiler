/**
 * @file test/storage/operation-inventory-binding.test.ts
 * @description The operation store walk, manifest read and inventory scan over
 * their own seams: the one walk body `scanOperationOrphansFrom(OperationStoreWalkReads)`,
 * the one manifest body `readOperationManifestFrom(OperationManifestLeafReads)` and
 * the one inventory body `scanOperationInventoryFrom(OperationInventoryReads)`. The
 * root forms keep their signatures and reach those bodies over the local-disk
 * reads (`diskOperationStoreWalkReads`, `diskOperationManifestLeafReads`,
 * `diskOperationInventoryReads`).
 *
 * HOW IT IS BUILT. Real projects are staged with the existing operation fixtures
 * (`executor-fixtures.ts`): a real key, a signed run, a canonical manifest and its
 * payload. Disk cases compare each root form with its body over the disk reads,
 * on that project and on one with planted problems. Memory cases hand the bodies
 * scripted doubles: a directory tree, manifest leaf bytes read back from disk, or
 * domain answers snapshotted from the real project's disk reads.
 *
 * WHAT IS MEMORY ONLY. A double is trusted exactly as far as the test supplies it:
 * it proves each body's order, words, caps, classification and verdicts, not
 * confinement, no-follow, handle-bound metadata or authentication, which stay in
 * the disk reads and are covered by the disk cases and the existing suites.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as inventoryScan from "../../src/utils/inventory-scan.js";
import type { CappedLeafReadBuffer } from "../../src/utils/confined-read.js";
import * as capacity from "../../src/operation-bundles/capacity.js";
import { diskOperationInventoryReads, scanOperationInventory, scanOperationInventoryFrom, type OperationInventoryReads } from "../../src/operation-bundles/capacity.js";
import * as catalogStore from "../../src/operation-bundles/catalog-store.js";
import { MAX_CATALOG_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PAYLOAD_BYTES } from "../../src/operation-bundles/constants.js";
import * as durableLeaf from "../../src/operation-bundles/durable-leaf.js";
import type { BundleId } from "../../src/operation-bundles/ids.js";
import { operationManifestDigest } from "../../src/operation-bundles/manifest-parse.js";
import * as inventoryAuthority from "../../src/operation-bundles/inventory-authority.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import * as manifestStore from "../../src/operation-bundles/manifest-store.js";
import { diskOperationManifestLeafReads, readOperationManifest, readOperationManifestFrom, type OperationManifestLeafReads } from "../../src/operation-bundles/manifest-store.js";
import * as orphanScan from "../../src/operation-bundles/orphan-scan.js";
import { diskOperationStoreWalkReads, scanOperationOrphans, scanOperationOrphansFrom, type OperationStoreWalkReads } from "../../src/operation-bundles/orphan-scan.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import * as runStore from "../../src/operation-bundles/run-store.js";
import { tempRootTracker } from "../temp-roots.js";
import { stageSourceBundle, WORKSPACE } from "../operation-bundles/executor-fixtures.js";

const PREFIX = "operation-inventory-binding-";
const STORE = path.join(".llmwiki", "workspaces");
const tracker = tempRootTracker();
let root = "";
let bundleId: BundleId;
let manifestBytes: Buffer;
beforeAll(async () => {
  root = await tracker.create(PREFIX);
  bundleId = (await stageSourceBundle(root)).bundleId as BundleId;
  manifestBytes = await readFile(operationPaths(root, WORKSPACE).manifestFile(bundleId));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

/** A staged project with planted problems: a `.tmp` alias, a stray leaf, an unknown directory and a quarantined leaf. */
async function messyRoot(): Promise<string> {
  const messy = await tracker.create(PREFIX);
  const id = (await stageSourceBundle(messy)).bundleId as BundleId;
  const paths = operationPaths(messy, WORKSPACE);
  await writeFile(`${paths.manifestFile(id)}.tmp`, "partial");
  await writeFile(path.join(paths.workspaceRoot, "stray.txt"), "stray");
  await mkdir(path.join(paths.workspaceRoot, "odd"));
  await mkdir(path.join(paths.quarantineRoot, "r1"), { recursive: true });
  await writeFile(path.join(paths.quarantineRoot, "r1", "held"), "held bytes");
  return messy;
}

type Node = "dir" | "file" | "other" | "unlistable";
/** A scripted store tree: each path's kind, each file's size or `absent`, and the visit log. */
function memoryWalk(tree: Record<string, Node>, sizes: Record<string, number | "absent">, log: string[] = []): OperationStoreWalkReads {
  const children = (dir: string) => Object.keys(tree).filter((key) => key !== "" && path.dirname(key) === (dir === "" ? "." : dir));
  return {
    visitDirectory: async (directory, visitor) => {
      log.push(`visit ${directory}`);
      if (tree[directory] === "unlistable") return "unlistable";
      for (const child of children(directory)) {
        const kind = tree[child];
        if (!visitor.take()) break;
        await visitor.inspect({ name: path.basename(child), isDirectory: () => kind === "dir" || kind === "unlistable", isFile: () => kind === "file", isSymbolicLink: () => false });
      }
      return "visited";
    },
    observeLeaf: async (file) => {
      const size = sizes[file] ?? 1;
      return size === "absent" ? { kind: "absent" } : { kind: "confirmed", size, dev: 1, ino: Object.keys(tree).indexOf(file) };
    },
  };
}

describe("the operation store walk: one body over its own reads", () => {
  it("W1 walks a real project and one with planted problems alike through the root form and the body over the disk reads", async () => {
    const messy = await messyRoot();
    for (const at of [root, messy]) expect(await scanOperationOrphansFrom(diskOperationStoreWalkReads(at))).toEqual(await scanOperationOrphans(at));
    const scan = await scanOperationOrphans(messy);
    // Directory listing order is the filesystem's, so the two planted problems are compared as a set.
    expect(scan.problems).toHaveLength(2);
    expect(scan.problems).toEqual(expect.arrayContaining([
      { dimension: "operation-entry", detail: "unknown operation directory", path: path.join(STORE, WORKSPACE, "odd") },
      { dimension: "operation-entry", detail: "unknown operation leaf", path: path.join(STORE, WORKSPACE, "stray.txt") },
    ]));
    const alias = scan.leaves.find((leaf) => leaf.protocolAlias === "tmp");
    expect([alias?.kind, alias?.logicalRelativePath.endsWith("manifest.json"), scan.leaves.some((leaf) => leaf.kind === "quarantine")]).toEqual(["manifest", true, true]);
  });

  it("W2 keeps order, words, caps, aliases, quarantine and foreign-store skipping in the body over a scripted tree", async () => {
    const bundle = path.join(WORKSPACE, "bundles", bundleId), log: string[] = [];
    const tree: Record<string, Node> = {
      [WORKSPACE]: "dir", [path.join(WORKSPACE, "bundles")]: "dir", [bundle]: "dir",
      [path.join(bundle, "manifest.json")]: "file", [path.join(bundle, "manifest.json.tmp")]: "file",
      [path.join(WORKSPACE, "catalog.jsonl")]: "file", [path.join(WORKSPACE, "odd")]: "dir", [path.join(WORKSPACE, "fifo")]: "other",
      [path.join(WORKSPACE, "preparations")]: "dir", [path.join(WORKSPACE, "runs")]: "unlistable",
      ".quarantine": "dir", [path.join(".quarantine", "r1")]: "dir", [path.join(".quarantine", "r1", ".hidden")]: "file",
    };
    const sizes = { [path.join(bundle, "manifest.json")]: "absent" as const, [path.join(WORKSPACE, "catalog.jsonl")]: MAX_CATALOG_FILE_BYTES + 1 };
    const scan = await scanOperationOrphansFrom(memoryWalk(tree, sizes, log));
    expect(scan.problems.map((item) => `${item.dimension}|${item.detail}|${item.path}`)).toEqual([
      `leaf-unavailable|operation leaf is absent|${path.join(STORE, bundle, "manifest.json")}`,
      `catalog-bytes|operation leaf exceeds its byte cap|${path.join(STORE, WORKSPACE, "catalog.jsonl")}`,
      `operation-entry|unknown operation directory|${path.join(STORE, WORKSPACE, "odd")}`,
      `operation-entry|unsupported operation entry|${path.join(STORE, WORKSPACE, "fifo")}`,
      `directory-unavailable|operation directory cannot be listed|${path.join(STORE, WORKSPACE, "runs")}`,
      `operation-entry|dot entry inside operation quarantine|${path.join(STORE, ".quarantine", "r1", ".hidden")}`,
    ]);
    expect(scan.leaves.map((leaf) => [leaf.kind, leaf.protocolAlias, leaf.logicalRelativePath])).toEqual([
      ["manifest", "tmp", path.join(bundle, "manifest.json")], ["catalog", undefined, path.join(WORKSPACE, "catalog.jsonl")],
      ["quarantine", undefined, path.join(".quarantine", "r1", ".hidden")],
    ]);
    expect([scan.workspaces, scan.bundleDirectories, log.includes(`visit ${path.join(WORKSPACE, "preparations")}`)]).toEqual([[WORKSPACE], [{ workspaceId: WORKSPACE, bundleId }], false]);
  });

  it("W3 fails closed in the body: the entry bound is a problem, a bad bound and a mid-visit failure reject rather than read as empty", async () => {
    const tree: Record<string, Node> = { [WORKSPACE]: "dir", [path.join(WORKSPACE, "a")]: "file", [path.join(WORKSPACE, "b")]: "file" };
    const bounded = await scanOperationOrphansFrom(memoryWalk(tree, {}), { maxDirectoryEntriesForTest: 2 });
    expect([bounded.leaves.length, bounded.problems.at(-1)]).toEqual([1, { dimension: "directory-entries", detail: "operation inventory entry bound exceeded", path: path.join(STORE, WORKSPACE) }]);
    await expect(scanOperationOrphansFrom(memoryWalk(tree, {}), { maxDirectoryEntriesForTest: 0 })).rejects.toThrow("operation inventory entry bound must be a positive safe integer");
    const failing: OperationStoreWalkReads = { ...memoryWalk(tree, {}), observeLeaf: async () => { throw new Error("leaf read failed mid-visit"); } };
    await expect(scanOperationOrphansFrom(failing)).rejects.toThrow("leaf read failed mid-visit");
  });
});

/** A scripted manifest leaf: one answer (or a throw), the cap each read asked for. */
function manifestLeaves(answer: CappedLeafReadBuffer | Error, caps: number[] = []): OperationManifestLeafReads {
  return { manifestLeavesIn: () => async (_bundle, maxBytes) => { caps.push(maxBytes); if (answer instanceof Error) throw answer; return answer; } };
}

describe("the operation manifest read: one body over its own leaves", () => {
  it("M1 reads the real manifest through the root form and the body over the disk leaves alike, keeping both identity boundaries", async () => {
    const viaRoot = await readOperationManifest(root, WORKSPACE, bundleId);
    expect(viaRoot.status).toBe("ok");
    expect(await readOperationManifestFrom(diskOperationManifestLeafReads(root), WORKSPACE, bundleId)).toEqual(viaRoot);
    const badWorkspace = [await readOperationManifest(root, "../escape", bundleId), await readOperationManifestFrom(diskOperationManifestLeafReads(root), "../escape", bundleId)];
    expect(badWorkspace).toEqual([{ status: "unavailable", detail: "identity" }, { status: "unavailable", detail: "identity" }]);
    await expect(readOperationManifest(root, WORKSPACE, "bnd_bad" as BundleId)).rejects.toThrow();
    await expect(readOperationManifestFrom(diskOperationManifestLeafReads(root), WORKSPACE, "bnd_bad" as BundleId)).rejects.toThrow();
  });

  it("M2 decides in the body: strict UTF-8, canonical bytes and exact binding; absent and unavailable stay distinct; the cap is the manifest cap", async () => {
    const caps: number[] = [];
    const read = (answer: CappedLeafReadBuffer | Error, id: BundleId = bundleId) => readOperationManifestFrom(manifestLeaves(answer, caps), WORKSPACE, id);
    expect(await read({ kind: "ok", body: manifestBytes })).toEqual(await readOperationManifest(root, WORKSPACE, bundleId));
    const pretty = Buffer.from(JSON.stringify(JSON.parse(manifestBytes.toString("utf8")), null, 2));
    const other = bundleId.replace(/.$/, (last) => (last === "0" ? "1" : "0")) as BundleId;
    expect(await Promise.all([read({ kind: "absent" }), read({ kind: "unavailable" }), read({ kind: "ok", body: pretty }), read({ kind: "ok", body: manifestBytes }, other)])).toEqual([
      { status: "absent" }, { status: "unavailable", detail: "manifest-leaf" },
      { status: "invalid", detail: "operation manifest is not canonical" }, { status: "invalid", detail: "operation manifest identity binding mismatch" },
    ]);
    expect((await read({ kind: "ok", body: Buffer.from([0xff, 0xfe]) })).status).toBe("invalid");
    await expect(read(new Error("leaf rejected"))).rejects.toThrow("leaf rejected");
    const unsafe: OperationManifestLeafReads = { manifestLeavesIn: () => { throw new Error("unsafe workspace"); } };
    expect(await readOperationManifestFrom(unsafe, WORKSPACE, bundleId)).toEqual({ status: "unavailable", detail: "identity" });
    expect(caps.every((cap) => cap === MAX_MANIFEST_BYTES) && caps.length === 7).toBe(true);
  });
});

type Snapshot = { [K in keyof OperationInventoryReads]: Awaited<ReturnType<OperationInventoryReads[K]>> };
/** Snapshot every domain answer the real project's disk reads give, once. */
async function snapshot(): Promise<Snapshot> {
  const disk = diskOperationInventoryReads(root), scanStore = await disk.scanStore({});
  const manifest = await disk.readManifest(WORKSPACE, bundleId);
  if (manifest.status !== "ok") throw new Error("fixture manifest unreadable");
  const [mutation] = manifest.manifest.mutations, digest = "payloadRef" in mutation! ? mutation.payloadRef : "";
  const readKeyEpoch = await disk.readKeyEpoch();
  if (readKeyEpoch.status !== "ok") throw new Error("fixture key unreadable");
  return {
    scanStore, verifyAuthorities: await disk.verifyAuthorities(scanStore.leaves), readManifest: manifest,
    readPayloadLeaf: await disk.readPayloadLeaf(WORKSPACE, bundleId, digest, MAX_PAYLOAD_BYTES), readKeyEpoch,
    readRun: await disk.readRun({ bundleId, runId: manifest.manifest.runId, workspaceId: WORKSPACE, manifestDigest: operationManifestDigest(manifest.manifest) as `sha256:${string}`, keyEpochId: readKeyEpoch.keyEpochId }),
    readCatalog: await disk.readCatalog(WORKSPACE),
  };
}

/** Memory reads answering from a snapshot (with overrides), every call logged by name. */
function memoryInventory(answers: Snapshot, log: string[]): OperationInventoryReads {
  const answer = <K extends keyof Snapshot>(name: K) => async () => { log.push(name); return answers[name]; };
  return {
    scanStore: answer("scanStore"), verifyAuthorities: answer("verifyAuthorities"), readManifest: answer("readManifest"),
    readPayloadLeaf: answer("readPayloadLeaf"), readKeyEpoch: answer("readKeyEpoch"), readRun: answer("readRun"), readCatalog: answer("readCatalog"),
  } as OperationInventoryReads;
}

describe("the operation inventory scan: one body over its own reads", () => {
  it("I1 inventories a real project and one with planted problems alike through the root form and the body over the disk reads", async () => {
    const messy = await messyRoot();
    const clean = await scanOperationInventory(root);
    expect([clean.problems, [...clean.completeBundleIds], clean.pendingBundles]).toEqual([[], [bundleId], 1]);
    expect(await scanOperationInventoryFrom(diskOperationInventoryReads(root))).toEqual(clean);
    const dirty = await scanOperationInventory(messy);
    expect(dirty.problems.length > 0 && dirty.epoch.bundles.health === "unavailable" && dirty.quarantine.count === 1).toBe(true);
    expect(await scanOperationInventoryFrom(diskOperationInventoryReads(messy))).toEqual(dirty);
  });

  it("I2 runs the steps in the incumbent order over snapshot reads, equals the root form, and reads the key and run fresh on each scan", async () => {
    const answers = await snapshot(), log: string[] = [];
    expect(await scanOperationInventoryFrom(memoryInventory(answers, log))).toEqual(await scanOperationInventory(root));
    expect(log).toEqual(["scanStore", "verifyAuthorities", "readManifest", "readPayloadLeaf", "readKeyEpoch", "readRun", "readCatalog"]);
    await scanOperationInventoryFrom(memoryInventory(answers, log));
    expect([log.filter((name) => name === "readKeyEpoch").length, log.filter((name) => name === "readRun").length]).toEqual([2, 2]);
    const problem = { dimension: "source-state", detail: "retained source is unavailable or invalid" };
    const appended = await scanOperationInventoryFrom(memoryInventory({ ...answers, scanStore: { ...answers.scanStore, problems: [{ dimension: "first", detail: "walk" }] }, verifyAuthorities: [problem] }, []));
    expect(appended.problems.slice(0, 2)).toEqual([{ dimension: "first", detail: "walk" }, problem]);
  });

  it("I3 keeps faults as faults in the body: payload digest and byte claims, key, run and catalog states, and a rejecting walk", async () => {
    const answers = await snapshot();
    const scan = async (overrides: Partial<Snapshot>, log: string[] = []) => scanOperationInventoryFrom(memoryInventory({ ...answers, ...overrides }, log));
    const payload = answers.readPayloadLeaf.kind === "ok" ? answers.readPayloadLeaf.body : Buffer.alloc(0);
    const tampered = await scan({ readPayloadLeaf: { kind: "ok", body: Buffer.concat([payload, Buffer.from("x")]) } });
    expect([tampered.problems, tampered.completeBundleIds.size, tampered.epoch.bundles.health]).toEqual([[{ dimension: "payload-state", detail: "manifest payload is unavailable or invalid" }], 0, "unavailable"]);
    if (answers.readManifest.status !== "ok") throw new Error("snapshot manifest");
    const claimed = structuredClone(answers.readManifest.manifest) as unknown as { mutations: { postcondition: { byteCount: number } }[] };
    claimed.mutations[0]!.postcondition.byteCount += 1;
    const log: string[] = [];
    expect((await scan({ readManifest: { status: "ok", manifest: claimed as never } }, log)).problems).toEqual([{ dimension: "payload-state", detail: "manifest payload is unavailable or invalid" }]);
    expect(log.includes("readKeyEpoch")).toBe(false);
    expect((await scan({ readKeyEpoch: { status: "absent" } })).problems).toEqual([{ dimension: "run-state", detail: "operation key is absent" }]);
    expect((await scan({ readRun: { status: "unavailable", detail: "run-leaf" } })).problems).toEqual([{ dimension: "run-state", detail: "operation run is unavailable" }]);
    expect((await scan({ readCatalog: { status: "invalid", detail: "catalog record is invalid" } })).problems).toEqual([{ dimension: "catalog-state", detail: "catalog record is invalid" }]);
    const rejecting: OperationInventoryReads = { ...memoryInventory(answers, []), scanStore: async () => { throw new Error("walk failed"); } };
    await expect(scanOperationInventoryFrom(rejecting)).rejects.toThrow("walk failed");
  });

  it("I4 makes no ambient read from the bound bodies, while the root forms reach every incumbent", async () => {
    const answers = await snapshot();
    const spies = [
      vi.spyOn(orphanScan, "scanOperationOrphans"), vi.spyOn(inventoryScan, "visitInventoryDirectory"), vi.spyOn(inventoryScan, "observeInventoryLeaf"),
      vi.spyOn(inventoryAuthority, "verifyInventoryAuthoritiesFrom"), vi.spyOn(manifestStore, "readOperationManifest"), vi.spyOn(durableLeaf, "readDurableOperationLeafBuffer"),
      vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(runStore, "readOperationRunFrom"), vi.spyOn(catalogStore, "readCatalogStore"),
    ];
    await scanOperationInventoryFrom(memoryInventory(answers, []));
    await scanOperationOrphansFrom(memoryWalk({ [WORKSPACE]: "dir" }, {}));
    await readOperationManifestFrom(manifestLeaves({ kind: "ok", body: manifestBytes }), WORKSPACE, bundleId);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    expect((await capacity.scanOperationInventory(root)).problems).toEqual([]);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
  });
});
