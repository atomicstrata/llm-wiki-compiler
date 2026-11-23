/**
 * @file Exercises the real stage journal writer and its narrow pre-install retry.
 * The project paths and data are synthetic. No exporter or phase is invoked.
 */
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { leafDigest } from "../../src/scale/downgrade-fs.js";
import { latestStage, readStageOf, recordPlan, recordStage, stagedPath } from "../../src/scale/downgrade-journal.js";
import { buildDowngradePlan, parseDowngradePlan, serializeDowngradePlan } from "../../src/scale/downgrade-plan.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import * as durability from "../../src/utils/atomic-write-durability.js";
import { EVENTS_FILE, RELATIONS_FILE } from "../../src/utils/constants.js";

const expectedBytes = '{"synthetic":"staged"}\n';
const incumbentBytes = '{"synthetic":"prior"}\n';
const indexedDir = ".llmwiki/indexed";
const fault = "injected stage parent sync failure after publication";

/** Hash the exact synthetic bytes bound by the fixture plan. */
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Restore the path-matched hook at the end of each call, even if an assertion fails. */
async function failLinkedSync(target: string, work: () => Promise<unknown>): Promise<void> {
  const sync = durability.fsyncDirectoryChain;
  const seam = spyOn(durability, "fsyncDirectoryChain").mockImplementation((parent, binding, before, scope) =>
    sync(parent, binding, async (entry) => {
      await before?.(entry);
      if (entry === path.dirname(target) && await lstat(target).catch(() => null)) throw new Error(fault);
    }, scope));
  try {
    await expect(work()).rejects.toThrow(fault);
  } finally {
    seam.mockRestore();
  }
}

/** Derive and parse one schema-valid plan with present and absent units and priors. */
function planFor(root: string) {
  const plan = buildDowngradePlan(root, {
    from: "local-indexed", target: "local-standard", record: { revision: 2, sha256: sha("old record") },
    requested: planScaleV2({ documents: 100 }).requested,
    measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 },
    freeze: { entries: 0, bytes: 0, digest: "" }, stores: [],
    units: [
      { kind: "events", relPath: EVENTS_FILE, present: true, bytes: Buffer.byteLength(expectedBytes), sha256: sha(expectedBytes), records: 1 },
      { kind: "relations", relPath: RELATIONS_FILE, present: false, bytes: 0, sha256: null, records: 0 },
    ],
    priors: [
      { relPath: EVENTS_FILE, sha256: sha(incumbentBytes), bytes: Buffer.byteLength(incumbentBytes) },
      { relPath: RELATIONS_FILE, sha256: null, bytes: 0 },
      { relPath: ".llmwiki/embeddings.json", sha256: null, bytes: 0 },
    ],
    runs: [], lastRun: null, pins: { labels: [], digest: "" }, capabilities: [], notices: [], blockers: [],
  });
  return parseDowngradePlan(serializeDowngradePlan(plan), root);
}

/** Construct the same manifest body as A5 from verified fixture bytes and live identities. */
async function seed(root: string) {
  const plan = planFor(root);
  const dir = `.llmwiki/scale-downgrade/3-${plan.digest.slice(0, 12)}`;
  const staged = stagedPath(dir, 1, EVENTS_FILE);
  await mkdir(path.dirname(path.join(root, staged)), { recursive: true });
  await mkdir(path.join(root, indexedDir), { recursive: true });
  await writeFile(path.join(root, staged), expectedBytes, { mode: 0o600 });
  await mkdir(path.dirname(path.join(root, EVENTS_FILE)), { recursive: true });
  await writeFile(path.join(root, EVENTS_FILE), incumbentBytes, { mode: 0o600 });
  await recordPlan(root, dir, plan);
  const exported = await leafDigest(root, staged);
  const prior = await leafDigest(root, EVENTS_FILE);
  if (exported.kind !== "ok" || prior.kind !== "ok") throw new Error("missing fixture input");
  const input = {
    plan: plan.digest, attempt: 1,
    units: plan.inventory.units.map((unit) => ({ ...unit, staged: unit.present ? exported.identity : null })),
    priors: plan.inventory.priors.map(({ relPath, sha256 }) => ({ relPath, sha256, identity: sha256 === null ? null : prior.identity })),
  };
  const target = path.join(root, dir, "attempt-1", "stage.json");
  return { root, dir, plan, input, staged: path.join(root, staged), target };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

/** Keep setup and teardown confined to the runner's private temp directory. */
async function withStage(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "stage-replay-"));
  try { await work(await seed(root)); }
  finally { await rm(root, { recursive: true }); }
}

/** Use the original writer, and prove exactly when its sync failed. */
async function interrupt(fixture: Fixture): Promise<bigint> {
  const { root, dir, input, plan, target } = fixture;
  await failLinkedSync(target, () => recordStage(root, dir, input));
  const original = await lstat(target, { bigint: true });
  expect(original.nlink).toBe(2n);
  expect((await lstat(target + ".tmp", { bigint: true })).ino).toBe(original.ino);
  expect((await lstat(target)).mode & 0o777).toBe(0o600);
  expect(await readFile(target, "utf8")).toBe(JSON.stringify({ format: "llmwiki-scale-downgrade-stage", version: 1, ...input }) + "\n");
  await expect(lstat(target + ".writing")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readStageOf(root, dir, 1, plan.digest)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  return original.ino;
}

/** Retry only the journal boundary, using the plan provided before the interrupted write. */
function retry({ root, dir, plan }: Fixture) {
  return latestStage(root, dir, plan.digest, plan);
}

test("settles an exact post-link stage when the plan's sources are still in place", async () => {
  await withStage(async (fixture) => {
    const { target, staged, root, dir, plan, input } = fixture;
    const inode = await interrupt(fixture);
    await expect(latestStage(root, dir, plan.digest)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    await expect(retry(fixture)).resolves.toMatchObject({ manifest: input, nextAttempt: 2 });
    expect(await lstat(target, { bigint: true })).toMatchObject({ ino: inode, nlink: 1n });
    await expect(lstat(target + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readStageOf(root, dir, 1, plan.digest)).toMatchObject(input);
    expect(await readFile(staged, "utf8")).toBe(expectedBytes);
    expect(await readFile(path.join(root, EVENTS_FILE), "utf8")).toBe(incumbentBytes);
    await expect(lstat(path.join(root, dir, "prior"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("a repeated sync failure retains the exact links for another retry", async () => {
  await withStage(async (fixture) => {
    const inode = await interrupt(fixture);
    await failLinkedSync(fixture.target, () => retry(fixture));
    for (const leaf of [fixture.target, fixture.target + ".tmp"]) {
      expect(await lstat(leaf, { bigint: true })).toMatchObject({ ino: inode, nlink: 2n });
    }
    await expect(retry(fixture)).resolves.toMatchObject({ manifest: fixture.input });
  });
});

test.each([["staged bytes"], ["prior identity"], ["move"], ["foreign alias"], ["unexpected child"], ["later attempt"], ["symlinked directory"]])(
  "refuses after %s changes and retains both evidence names", async (change) => {
    await withStage(async (fixture) => {
      const { root, dir, target, staged } = fixture;
      const inode = await interrupt(fixture);
      const alias = target + ".tmp";
      if (change === "staged bytes") await writeFile(staged, "changed");
      if (change === "prior identity") {
        const prior = path.join(root, EVENTS_FILE);
        await writeFile(prior + ".next", incumbentBytes);
        await rename(prior + ".next", prior);
      }
      if (change === "move") await mkdir(path.join(root, dir, "prior"));
      if (change === "foreign alias") {
        await rename(alias, target + ".foreign");
        await writeFile(alias, "foreign");
      }
      if (change === "unexpected child") await writeFile(staged + ".tmp", "reserved");
      if (change === "later attempt") await mkdir(path.join(root, dir, "attempt-2"));
      if (change === "symlinked directory") {
        const parent = path.dirname(staged);
        await rename(parent, parent + "-other");
        await symlink(parent + "-other", parent);
      }
      const before = await lstat(alias, { bigint: true });
      const body = await readFile(alias, "utf8");
      await expect(retry(fixture)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
      expect(await lstat(target, { bigint: true })).toMatchObject({ ino: inode, nlink: 2n });
      expect(await lstat(alias, { bigint: true })).toMatchObject({ ino: before.ino, nlink: before.nlink });
      expect(await readFile(alias, "utf8")).toBe(body);
    });
  },
);

test("an attempt with only nonpublished scratch still yields the next attempt", async () => {
  await withStage(async (fixture) => {
    const { target, dir, root, input } = fixture;
    await recordStage(root, dir, input);
    const ready = target + ".tmp";
    await link(target, ready);
    await unlink(target);
    const original = await lstat(ready, { bigint: true });
    expect(await retry(fixture)).toEqual({ manifest: null, nextAttempt: 2 });
    expect(await lstat(ready, { bigint: true })).toMatchObject({ ino: original.ino, nlink: 1n });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
