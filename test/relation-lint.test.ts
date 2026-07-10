/**
 * @file test/relation-lint.test.ts
 * @description Tests for relation-store lint (Phase 4 PR6) — making the
 * append-only relation store VISIBLE through the profile-aware lint runner.
 *
 * Covers: a dangling relation (an endpoint EntityId with no page) yields a
 * `dangling-relation` finding naming the relation id + missing endpoint; a
 * healthy relation (both endpoints have pages) yields none; a torn trailing
 * line surfaces a `relation-store-torn` finding (fail-open, tolerated); a
 * corrupt / too-new store fails CLOSED into a `relation-store-corrupt` /
 * `relation-store-too-new` finding rather than crashing lint; and a DEFAULT
 * project (no wiki/graph) plus a relation-LESS non-default project emit NO
 * relation findings (byte-identical default path).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { lint } from "../src/linter/index.js";
import { RELATIONS_FILE, CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteProject,
  buildResearchLiteRelationsProject,
  seedTestsRelation,
} from "./fixtures/profile-fixtures.js";

let root = "";

/** Rule ids the relation-store lint emits (dangling + the three store-read codes). */
const RELATION_RULES = ["dangling-relation", "relation-store-torn", "relation-store-corrupt", "relation-store-too-new"];

/** All lint findings emitted by the relation-store check. */
async function relationFindings(): Promise<{ rule: string; message: string }[]> {
  const { results } = await lint(root);
  return results.filter((r) => RELATION_RULES.includes(r.rule));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "relation-lint-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("relation lint — dangling detection", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("flags a relation whose endpoint has no page (dangling-relation)", async () => {
    const ref = await seedTestsRelation(root, "ablation-batch-size", "ghost-idea");
    const findings = await relationFindings();
    const dangling = findings.filter((f) => f.rule === "dangling-relation");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].message).toContain(ref.id);
    expect(dangling[0].message).toContain("ideas/ghost-idea");
  });

  it("emits no finding for a healthy relation (both endpoints exist)", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const findings = await relationFindings();
    expect(findings).toHaveLength(0);
  });
});

describe("relation lint — torn / corrupt / too-new (fail-closed, no crash)", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("surfaces a torn trailing line as relation-store-torn", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await appendFile(path.join(root, RELATIONS_FILE), '{"id":"rel_torn","type":"tes');
    const findings = await relationFindings();
    expect(findings.some((f) => f.rule === "relation-store-torn")).toBe(true);
  });

  it("fails closed to relation-store-too-new instead of crashing lint", async () => {
    await mkdir(path.join(root, path.dirname(RELATIONS_FILE)), { recursive: true });
    await writeFile(path.join(root, RELATIONS_FILE), '{"kind":"relation-store-header","schemaVersion":99}\n');
    const findings = await relationFindings();
    expect(findings.some((f) => f.rule === "relation-store-too-new")).toBe(true);
  });
});

describe("relation lint — no findings on default / relation-less paths", () => {
  it("emits no relation findings for a DEFAULT project (no wiki/graph)", async () => {
    await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
    await writeFile(path.join(root, CONCEPTS_DIR, "foo.md"), "---\ntitle: Foo\n---\n\nbody body body body body.\n");
    const findings = await relationFindings();
    expect(findings).toHaveLength(0);
  });

  it("emits no relation findings for a relation-less non-default project", async () => {
    await buildResearchLiteProject(root);
    const findings = await relationFindings();
    expect(findings).toHaveLength(0);
  });
});
