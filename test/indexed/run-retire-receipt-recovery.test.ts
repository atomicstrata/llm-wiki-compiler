/**
 * @file test/indexed/run-retire-receipt-recovery.test.ts
 * @description An interrupted cleanup-receipt publication (IDX-1, slice 2)
 * through the PUBLIC retirement preview and apply, in this process.
 *
 * A retirement writes `<store>.receipt.json` create-only BEFORE it moves the
 * store, so a stop inside the writer leaves W (`.writing`), W+R (`.tmp`), R or
 * R+F beside a store still in place. Each such exact, writer-shaped receipt of
 * this project, for a store still at its recorded directory identity with
 * exactly its recorded leaves and manifest, must be planned as an UNMOVED
 * cleanup bound to its exact bytes and applied as metadata-only discard: the
 * store stays exactly as it was, every receipt name goes. Everything else
 * refuses before any effect and keeps every name and byte: a truncated W, a
 * wrong mode, a token that is not a string (REC-1), another project's
 * receipt, a changed store, an existing
 * quarantine destination, a store already moved, and two interrupted groups
 * at once. A plan made before the receipt changed is stale. A plain
 * retirement (no receipt) still retires its candidates.
 *
 * FIXTURE. A template with two durable done runs, a CONSTRUCTED compile-state
 * manifest (no last run) committed through the real store, and an active
 * `local-indexed` record, copied per case without the template's reader
 * leases. Receipts are planted with the writer's exact serialization.
 *
 * LABELLED SEAMS: `serializeOwner` (own-PID record) for the raw lock, leases
 * and barrier; and the PREVIEW runs inside `runWithLockedMetadataReads`, the
 * lease-free scope a locked inventory uses, standing in for a preview made by
 * another process (a preview here would otherwise register this process as a
 * reader and make it an inadmissible collector for the apply).
 */

import { createHash } from "node:crypto";
import { appendFile, chmod, link, lstat, mkdir, opendir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { openCompileState } from "../../src/cstate/store.js";
import { applyRunRetirement, previewRunRetirement, type RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { runWithLockedMetadataReads } from "../../src/segments/reader-lease.js";
import { newScratchBatchRun } from "../batch/scratch-run.js";
import { copyProjectTemplate, privateRoots, withOwnPidOwnerSeam as withOwnerSeam } from "../fixtures/scoped-test-roots.js";

/** Durable commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const RETIRING = ".llmwiki/indexed-retiring";
/** Keep every finished run's report: the plan has no candidate, so only the cleanup acts. */
const KEEP_ALL = 100;
const ACTIVE_INDEXED: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 1, requested: { documents: 100, sizeBytes: 102400, documentsBasis: "stated", sizeBasis: "stated" }, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };
/** A constructed, schema-valid compile-state meta with no last run. */
const COMPILE_STATE_META = { schema: 1, version: 2, indexHash: "fixture", promptModifiers: null, frozenPresent: false, sources: 0, owners: 0, frozen: 0, nextOrdinal: 0, lastRun: null, legacy: { relPath: ".llmwiki/state.json", stamp: null, records: 0, bytes: 0, sha256: null } };
const { privateDir, cleanup } = privateRoots("llmwiki-receipt-recovery-");
let template = "";
let stores: string[] = [];

beforeAll(() => withOwnerSeam(async () => {
  template = await privateDir();
  for (let at = 0; at < 2; at++) {
    const run = await newScratchBatchRun(template);
    await run.advance("done");
    stores.push(`crun-${run.runId}`);
  }
  stores = stores.sort();
  const cstate = await openCompileState(template);
  await cstate.commit({ meta: COMPILE_STATE_META });
  await writeFile(path.join(template, SCALE_RECORD_FILE), serializeAnyScaleRecord(ACTIVE_INDEXED));
}), CASE_TIMEOUT_MS);
afterAll(cleanup);

/** A copy of the template this process never registered on. */
const project = (): Promise<string> => copyProjectTemplate(template, privateDir);

/** The exact receipt bytes the writer would publish for `store` now (its leaves in the writer's listing order). */
async function receiptBytes(root: string, store: string, overrides: { rootDigest?: string; token?: string } = {}): Promise<string> {
  const dir = path.join(root, ".llmwiki", "indexed", store);
  const stat = await lstat(dir, { bigint: true });
  const leaves = [];
  for await (const entry of await opendir(dir)) {
    const leaf = await lstat(path.join(dir, entry.name), { bigint: true });
    leaves.push({ name: entry.name, size: String(leaf.size), dev: String(leaf.dev), ino: String(leaf.ino), mtimeNs: String(leaf.mtimeNs) });
  }
  const manifestSha256 = createHash("sha256").update(await readFile(path.join(dir, "manifest.json"))).digest("hex");
  const rootDigest = overrides.rootDigest ?? createHash("sha256").update(root).digest("hex");
  return `${JSON.stringify({ format: "llmwiki-run-retirement-receipt", version: 1, token: overrides.token ?? "a".repeat(32), rootDigest, store, eligibility: "done-not-last-run", manifestSha256, dir: { dev: String(stat.dev), ino: String(stat.ino) }, leaves })}\n`;
}

/** The receipt names of `store`, relative to the project. */
const namesOf = (store: string) => ({ F: `${RETIRING}/${store}.receipt.json`, R: `${RETIRING}/${store}.receipt.json.tmp`, W: `${RETIRING}/${store}.receipt.json.writing` });

/** Plant `bytes` for `store` in the writer state `state` (mode 0600 unless stated). */
async function plantReceipt(root: string, store: string, state: "W" | "WR" | "R" | "RF", bytes: string, mode = 0o600): Promise<void> {
  await mkdir(path.join(root, RETIRING), { recursive: true, mode: 0o700 });
  const names = namesOf(store);
  const first = path.join(root, state.startsWith("W") ? names.W : names.R);
  await writeFile(first, bytes);
  await chmod(first, mode);
  if (state === "WR") await link(first, path.join(root, names.R));
  if (state === "RF") await link(first, path.join(root, names.F));
}

/** Inode and bytes of every file under the quarantine and the indexed stores (null when absent): what a refusal must keep. */
async function dataState(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const top of [RETIRING, ".llmwiki/indexed"]) {
    const files = await readdir(path.join(root, top), { recursive: true }).catch(() => [] as string[]);
    for (const name of files) {
      const file = path.join(root, top, name);
      const info = await lstat(file, { bigint: true });
      state[`${top}/${name}`] = info.isFile() ? `${info.ino}:${info.mode}:${createHash("sha256").update(await readFile(file)).digest("hex")}` : "dir";
    }
  }
  return state;
}

/** A preview of `root` as another process would make it (labelled seam: the lease-free locked-metadata scope). */
async function previewOf(root: string, keepFinished = KEEP_ALL): Promise<RunRetirePreviewV1> {
  let preview: RunRetirePreviewV1 | undefined;
  await runWithLockedMetadataReads(root, async () => { preview = await previewRunRetirement(root, { keepFinished }); });
  return preview!;
}

/** The refusal code of `work`, or `accepted`. */
function codeOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));
}

/** The digest of `text`'s exact bytes. */
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("an interrupted cleanup receipt is planned and discarded as metadata only", () => {
  for (const state of ["W", "WR", "R", "RF"] as const) {
    it(`plans a ${state} receipt as an unmoved cleanup and discards only its names`, () => withOwnerSeam(async () => {
      const root = await project();
      const bytes = await receiptBytes(root, stores[0]!);
      await plantReceipt(root, stores[0]!, state, bytes);
      const before = await dataState(root);
      const preview = await previewOf(root);
      expect([preview.admissible, preview.plan.pendingCleanup]).toEqual([true, [{ store: stores[0]!, receiptSha256: sha256(bytes), phase: "unmoved" }]]);
      expect(await applyRunRetirement(root, preview.plan, { readersOffline: true })).toMatchObject({ retired: [], cleaned: 1, reclaimedBytes: 0 });
      const after = await dataState(root);
      expect(Object.keys(after).filter((name) => name.startsWith(RETIRING))).toEqual([]);
      expect(Object.fromEntries(Object.entries(after).filter(([name]) => name.startsWith(".llmwiki/indexed/")))).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => name.startsWith(".llmwiki/indexed/"))));
    }), CASE_TIMEOUT_MS);
  }

  it("refuses a plan made before the receipt changed as stale, changing nothing", () => withOwnerSeam(async () => {
    const root = await project();
    await plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!));
    const preview = await previewOf(root);
    expect(preview.admissible).toBe(true);
    await rm(path.join(root, namesOf(stores[0]!).R));
    await plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!, { token: "b".repeat(32) }));
    const before = await dataState(root);
    expect(await codeOf(applyRunRetirement(root, preview.plan, { readersOffline: true }))).toBe("indexed_runs_plan_stale");
    expect(await dataState(root)).toEqual(before);
  }), CASE_TIMEOUT_MS);
});

/** `bytes` with the token string replaced by a one-element array holding it, keys still in writer order (REC-1). */
function arrayToken(bytes: string): string {
  const token = `"token":"${"a".repeat(32)}"`;
  if (!bytes.includes(token)) throw new Error("fixture receipt has no default token");
  return bytes.replace(token, `"token":["${"a".repeat(32)}"]`);
}

/** A refused layout: how to plant it on a fresh project. */
type Layout = (root: string) => Promise<void>;
const REFUSED: readonly (readonly [string, Layout])[] = [
  ["a truncated W", async (root) => plantReceipt(root, stores[0]!, "W", (await receiptBytes(root, stores[0]!)).slice(0, 60))],
  ["a wrong-mode R", async (root) => plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!), 0o644)],
  ["an R whose token is a one-element array", async (root) => plantReceipt(root, stores[0]!, "R", arrayToken(await receiptBytes(root, stores[0]!)))],
  ["another project's R", async (root) => plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!, { rootDigest: "f".repeat(64) }))],
  ["an R whose store changed", async (root) => { await plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!)); await appendFile(path.join(root, ".llmwiki/indexed", stores[0]!, "manifest.json"), "\n"); }],
  ["an R beside an existing quarantine destination", async (root) => { await plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!)); await mkdir(path.join(root, RETIRING, stores[0]!)); }],
  ["an R whose store was already moved", async (root) => { await plantReceipt(root, stores[0]!, "R", await receiptBytes(root, stores[0]!)); await rename(path.join(root, ".llmwiki/indexed", stores[0]!), path.join(root, RETIRING, stores[0]!)); }],
  ["two interrupted receipt groups", async (root) => { for (const store of stores) await plantReceipt(root, store, "R", await receiptBytes(root, store)); }],
];

describe("anything else refuses before any effect and keeps every name and byte", () => {
  for (const [label, plant] of REFUSED) {
    it(`refuses ${label}`, () => withOwnerSeam(async () => {
      const root = await project();
      await plant(root);
      const before = await dataState(root);
      const preview = await previewOf(root);
      expect(preview.admissible).toBe(false);
      expect(await codeOf(applyRunRetirement(root, preview.plan, { readersOffline: true }))).toBe("indexed_runs_blocked");
      expect(await dataState(root)).toEqual(before);
    }), CASE_TIMEOUT_MS);
  }
});

describe("a plain retirement still retires its candidates", () => {
  it("retires both done runs with fresh receipts and leaves no quarantine", () => withOwnerSeam(async () => {
    const root = await project();
    const preview = await previewOf(root, 0);
    expect([preview.admissible, preview.retirableRuns]).toEqual([true, 2]);
    const done = await applyRunRetirement(root, preview.plan, { readersOffline: true });
    expect(done.retired.map((run) => run.store).sort()).toEqual(stores);
    expect(Object.keys(await dataState(root)).filter((name) => stores.some((store) => name.includes(store)))).toEqual([]);
  }), CASE_TIMEOUT_MS);
});
