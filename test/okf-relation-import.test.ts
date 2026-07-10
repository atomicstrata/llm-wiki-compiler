/**
 * @file Integration tests for the bundle-relation import leg (CLP 7.6 Task 5,
 * D-7.6.6): a parsed bundle relation is applied through the VALIDATED relation
 * store — TRUSTED MODE ONLY. Covers a trusted valid import (lands in the store
 * with the right endpoints/attributes), idempotent re-import (content-hash dedup),
 * unknown-type + endpoint-scope refusal (skipped-invalid), untrusted / default /
 * dry-run inert paths (store untouched), and newsroom genericity.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { readRelations } from "../src/relations/store-read.js";
import { buildFrontmatter } from "../src/utils/markdown.js";
import { buildResearchProject } from "./fixtures/research-profile.js";
import { installNewsroomProfile } from "./fixtures/newsroom-profile.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** One untrusted bundle-relation entry; the foreign id/contentHash are reporting-only (never trusted). */
function relEntry(type: string, from: string, to: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `foreign-${type}`, type, from, to, contentHash: "foreign-hash", ...over };
}

/** Write a `kb/` bundle whose index.md carries an x-llmwiki block with the given relations. */
async function writeRelationBundle(root: string, relations: Record<string, unknown>[]): Promise<string> {
  const bundleDir = path.join(root, "kb");
  await mkdir(bundleDir, { recursive: true });
  const front = buildFrontmatter({ okf_version: "0.1", "x-llmwiki": { relations } });
  await writeFile(path.join(bundleDir, "index.md"), `${front}\n# Bundle\n`);
  return bundleDir;
}

/** Fresh research project + a single-relation bundle, imported trusted; returns the report. */
async function importResearchRelation(prefix: string, entry: Record<string, unknown>) {
  dir = await mkdtemp(path.join(tmpdir(), prefix));
  await buildResearchProject(dir);
  const b = await writeRelationBundle(dir, [entry]);
  return runOkfImport(dir, b, { trusted: true });
}

describe("bundle-relation import — trusted apply", () => {
  it("lands a valid relation in the store with its endpoints + attributes", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-ok-"));
    await buildResearchProject(dir);
    const b = await writeRelationBundle(dir, [relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws", { attributes: { note: "seminal" } })]);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes).toEqual([{ type: "cites", from: "papers/attention-is-all-you-need", to: "papers/scaling-laws", outcome: "imported" }]);
    const { relations } = await readRelations(dir);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ type: "cites", from: "papers/attention-is-all-you-need", to: "papers/scaling-laws", attributes: { note: "seminal" } });
  });

  it("deduplicates an idempotent re-import (no duplicate record)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-dup-"));
    await buildResearchProject(dir);
    const entries = [relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws")];
    const b = await writeRelationBundle(dir, entries);
    await runOkfImport(dir, b, { trusted: true });
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes![0].outcome).toBe("deduplicated");
    expect((await readRelations(dir)).relations).toHaveLength(1);
  });

  it("deduplicates a duplicate within a single bundle", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-dup1-"));
    await buildResearchProject(dir);
    const rel = relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws");
    const b = await writeRelationBundle(dir, [rel, { ...rel, id: "foreign-2" }]);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes!.map((o) => o.outcome)).toEqual(["imported", "deduplicated"]);
    expect((await readRelations(dir)).relations).toHaveLength(1);
  });
});

describe("bundle-relation import — invalid entries (skipped, nothing written)", () => {
  /** Assert the sole outcome is a skipped-invalid refusal (reason matches) and nothing was written. */
  async function expectSkippedInvalid(report: { relationOutcomes?: { outcome: string; reason?: string }[] }, pattern: RegExp): Promise<void> {
    expect(report.relationOutcomes![0].outcome).toBe("skipped-invalid");
    expect(report.relationOutcomes![0].reason).toMatch(pattern);
    expect((await readRelations(dir)).relations).toHaveLength(0);
  }

  it("skips an unknown relation type as skipped-invalid", async () => {
    const report = await importResearchRelation("rel-unk-", relEntry("no-such-type", "papers/attention-is-all-you-need", "papers/scaling-laws"));
    await expectSkippedInvalid(report, /unknown relation type/i);
  });

  it("skips an endpoint-type scope refusal as skipped-invalid", async () => {
    // `tests` is from:experiments to:ideas; a papers→ideas from-endpoint is out of scope.
    const report = await importResearchRelation("rel-scope-", relEntry("tests", "papers/attention-is-all-you-need", "ideas/sparse-routing"));
    await expectSkippedInvalid(report, /from endpoint/i);
  });
});

describe("bundle-relation import — inert paths (store untouched)", () => {
  it("reports skipped-untrusted and writes nothing when untrusted", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-untr-"));
    await buildResearchProject(dir);
    const b = await writeRelationBundle(dir, [relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws")]);
    const report = await runOkfImport(dir, b, {});
    expect(report.relationOutcomes![0].outcome).toBe("skipped-untrusted");
    expect((await readRelations(dir)).relations).toHaveLength(0);
  });

  it("reports skipped-no-profile on a default project regardless of trusted", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-def-"));
    const b = await writeRelationBundle(dir, [relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws")]);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes![0].outcome).toBe("skipped-no-profile");
    expect((await readRelations(dir)).relations).toHaveLength(0);
  });

  it("reports skipped-dry-run and writes nothing on dryRun", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-dry-"));
    await buildResearchProject(dir);
    const b = await writeRelationBundle(dir, [relEntry("cites", "papers/attention-is-all-you-need", "papers/scaling-laws")]);
    const report = await runOkfImport(dir, b, { trusted: true, dryRun: true });
    expect(report.relationOutcomes![0].outcome).toBe("skipped-dry-run");
    expect((await readRelations(dir)).relations).toHaveLength(0);
  });

  it("omits relationOutcomes when the bundle carries no relations (parity)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-none-"));
    await buildResearchProject(dir);
    const b = await writeRelationBundle(dir, []);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes).toBeUndefined();
  });
});

describe("bundle-relation import — newsroom genericity", () => {
  it("imports a filed-under relation on the newsroom profile (second profile, same code)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rel-news-"));
    await installNewsroomProfile(dir);
    const b = await writeRelationBundle(dir, [relEntry("filed-under", "articles/port-strike-latest", "desks/metro")]);
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.relationOutcomes![0]).toEqual({ type: "filed-under", from: "articles/port-strike-latest", to: "desks/metro", outcome: "imported" });
    expect((await readRelations(dir)).relations).toHaveLength(1);
  });
});
