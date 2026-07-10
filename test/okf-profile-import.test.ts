/**
 * @file Integration tests for the TYPED profile-entity OKF import leg (CLP 7.6
 * Task 4): a bundle doc whose path prefix (or `x-llmwiki.entityType`) names an
 * ACTIVE-profile entity type stages through `stageEntityPage` + the trust planner,
 * NEVER the legacy `writeAll`. Covers untrusted typed staging, path-prefix vs
 * `x-llmwiki.entityType` disagreement, unknown-type + contract-violation fallback,
 * typed collision skips, the shared queue cap, default-profile parity, and
 * newsroom genericity. Trusted promotion + the F4 guardrail live in the sibling
 * `okf-profile-import-trusted.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { QueueFullError } from "../src/import/run-errors.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { installResearchProfile, buildResearchProject } from "./fixtures/research-profile.js";
import { installNewsroomProfile } from "./fixtures/newsroom-profile.js";
import { writeTypedBundle as writeBundle } from "./fixtures/okf-typed-bundle.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** Build a paper OKF doc; toggles the declared `entityType`, the required `authors`, and the lifecycle state. */
function paperDoc(entityType = "papers", withAuthors = true, state = "imported"): string {
  const authors = withAuthors ? "authors:\n  - A. Author\n" : "";
  return `---\ntype: papers\nx-llmwiki:\n  entityType: ${entityType}\n  lifecycle:\n    field: stage\n    state: ${state}\ntitle: New Paper\n${authors}---\n\nBody about attention.\n`;
}

describe("typed OKF import — untrusted staging", () => {
  it("stages a typed candidate carrying targetEntityType + imported-okf held reason", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/new-paper.md": paperDoc() });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed).toEqual([{ okfPath: "papers/new-paper.md", slug: "new-paper", entityType: "papers", outcome: "staged-typed" }]);
    const [candidate] = await listCandidates(dir);
    expect(candidate.targetEntityType).toBe("papers");
    expect(candidate.heldReasons).toEqual([{ code: "imported-okf" }]);
  });

  it("resolves entityType from x-llmwiki when the path prefix is not a declared type", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-x-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "inbox/thing.md": paperDoc() });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0].outcome).toBe("staged-typed");
    expect((await listCandidates(dir))[0].targetEntityType).toBe("papers");
  });
});

describe("typed OKF import — resolution disagreement (path prefix wins)", () => {
  it("uses the path-prefix entity type and warns when x-llmwiki.entityType disagrees", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-dis-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/foo.md": paperDoc("ideas") });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0].entityType).toBe("papers");
    expect((await listCandidates(dir))[0].targetEntityType).toBe("papers");
    expect(report.warnings.some((w) => /mismatch/i.test(w))).toBe(true);
  });
});

describe("typed OKF import — mismatch fallback (nothing dropped, nothing live)", () => {
  it("falls back to untyped staging for an unknown entity type", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-unk-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "inbox/thing.md": paperDoc("nonexistent") });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0].outcome).toBe("mismatch-fallback");
    expect(report.typed![0].reason).toMatch(/unknown entity type/i);
    const [candidate] = await listCandidates(dir);
    expect(candidate.targetEntityType).toBeUndefined();
    expect(candidate.heldReasons[0].detail).toMatch(/profile-mismatch/i);
  });

  it("falls back to untyped staging when the typed body violates the field contract", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-fc-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/bad.md": paperDoc("papers", false) });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0].outcome).toBe("mismatch-fallback");
    expect((await listCandidates(dir))[0].targetEntityType).toBeUndefined();
  });
});

describe("typed OKF import — collision policy", () => {
  it("skips a typed doc when a live typed page already exists", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-live-"));
    await buildResearchProject(dir);
    const before = (await listCandidates(dir)).length;
    const b = await writeBundle(dir, { "papers/attention-is-all-you-need.md": paperDoc() });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed).toEqual([{ okfPath: "papers/attention-is-all-you-need.md", slug: "attention-is-all-you-need", entityType: "papers", outcome: "skipped", reason: "live-page" }]);
    expect(await listCandidates(dir)).toHaveLength(before);
  });

  it("skips a typed doc when a pending candidate already targets it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-pend-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/new-paper.md": paperDoc() });
    await runOkfImport(dir, b, {});
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0].outcome).toBe("skipped");
    expect(report.typed![0].reason).toBe("pending-candidate");
    expect(await listCandidates(dir)).toHaveLength(1);
  });
});

describe("typed OKF import — shared queue cap + parity + genericity", () => {
  it("counts typed candidates against maxNewCandidates alongside untyped", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-cap-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/a.md": paperDoc(), "papers/b.md": paperDoc() });
    await expect(runOkfImport(dir, b, { maxNewCandidates: 1 })).rejects.toBeInstanceOf(QueueFullError);
  });

  it("treats an entity-path doc as a foreign untyped doc on a default project (parity)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-def-"));
    const b = await writeBundle(dir, { "papers/x.md": paperDoc() });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed).toBeUndefined();
    expect(report.pages).toEqual([{ slug: "papers-x", okfPath: "papers/x.md", targetDirectory: "concepts" }]);
  });

  it("stages a typed candidate for the newsroom profile (second profile, same code)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpi-news-"));
    await installNewsroomProfile(dir);
    const article = `---\ntype: articles\nx-llmwiki:\n  entityType: articles\n  lifecycle:\n    field: stage\n    state: draft\nheadline: Breaking News\n---\n\nA report.\n`;
    const b = await writeBundle(dir, { "articles/breaking.md": article });
    const report = await runOkfImport(dir, b, {});
    expect(report.typed![0]).toEqual({ okfPath: "articles/breaking.md", slug: "breaking", entityType: "articles", outcome: "staged-typed" });
    expect((await listCandidates(dir))[0].targetEntityType).toBe("articles");
  });
});
