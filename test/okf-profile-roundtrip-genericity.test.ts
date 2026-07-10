/**
 * @file Profile-aware OKF round-trip: genericity (newsroom, second profile, SAME
 * code, zero special-casing) + the untrusted leg (CLP 7.6 Task 6).
 *
 *  - NEWSROOM trusted round-trip: the SAME export→import path used for research
 *    promotes `articles`/`desks`/`bylines` live at their configured dirs with domain
 *    fields + lifecycle preserved and the `filed-under` relation round-tripped — no
 *    newsroom-specific code exists (Phase-7 C1 genericity).
 *  - UNTRUSTED round-trip: importing without `--trusted` STAGES every typed doc
 *    (`staged-typed`), reports relations `skipped-untrusted`, and leaves the store
 *    untouched (no live typed page, no relation). Approving one staged candidate
 *    through the promote seam then lands it at `wiki/<entityType>/<slug>.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readRelations } from "../src/relations/store-read.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { promoteCandidateUnderLock } from "../src/trust/promote.js";
import {
  installNewsroomProfile, buildNewsroomProject, seedNewsroomRelations,
} from "./fixtures/newsroom-profile.js";
import { exportBundle, importBundle } from "./fixtures/okf-roundtrip-helpers.js";
import type { OkfImportReport } from "../src/import/run.js";

/** True when a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("newsroom profile-aware OKF round-trip (trusted) — genericity", () => {
  let fresh: string, report: OkfImportReport;
  beforeAll(async () => {
    const src = await mkdtemp(path.join(tmpdir(), "okf-rt-news-src-"));
    await buildNewsroomProject(src);
    await seedNewsroomRelations(src);
    const bundle = await exportBundle(src);
    fresh = await mkdtemp(path.join(tmpdir(), "okf-rt-news-fresh-"));
    await installNewsroomProfile(fresh);
    report = await importBundle(fresh, bundle, true);
    await rm(src, { recursive: true, force: true });
  });
  afterAll(async () => { await rm(fresh, { recursive: true, force: true }); });

  it("promotes articles live with domain fields + lifecycle, no fallback", async () => {
    expect(report.typed!.every((t) => t.outcome === "promoted-typed")).toBe(true);
    const file = path.join(fresh, "wiki/articles/port-strike-latest.md");
    expect(await exists(file)).toBe(true);
    const { meta } = parseFrontmatter(await readFile(file, "utf-8"));
    expect(meta.headline).toBe("Port Strike Enters Second Week");
    expect(meta.stage).toBe("published");
  });

  it("round-trips the filed-under relation", async () => {
    expect(report.relationOutcomes!.every((r) => r.outcome === "imported")).toBe(true);
    const { relations } = await readRelations(fresh);
    const filed = relations.find((r) => r.type === "filed-under");
    expect(filed).toMatchObject({ from: "articles/port-strike-latest", to: "desks/metro" });
  });
});

describe("newsroom profile-aware OKF round-trip (untrusted)", () => {
  let fresh: string, report: OkfImportReport;
  beforeAll(async () => {
    const src = await mkdtemp(path.join(tmpdir(), "okf-rt-unt-src-"));
    await buildNewsroomProject(src);
    await seedNewsroomRelations(src);
    const bundle = await exportBundle(src);
    fresh = await mkdtemp(path.join(tmpdir(), "okf-rt-unt-fresh-"));
    await installNewsroomProfile(fresh);
    report = await importBundle(fresh, bundle, false);
    await rm(src, { recursive: true, force: true });
  });
  afterAll(async () => { await rm(fresh, { recursive: true, force: true }); });

  it("stages typed docs and leaves the store untouched", async () => {
    expect(report.typed!.every((t) => t.outcome === "staged-typed")).toBe(true);
    expect(report.relationOutcomes!.every((r) => r.outcome === "skipped-untrusted")).toBe(true);
    expect(await exists(path.join(fresh, "wiki/articles/port-strike-latest.md"))).toBe(false);
    expect((await readRelations(fresh)).relations).toHaveLength(0);
  });

  it("promotes an approved staged candidate to its typed path", async () => {
    const candidate = (await listCandidates(fresh)).find((c) => c.targetEntityType === "articles")!;
    expect(candidate).toBeDefined();
    await promoteCandidateUnderLock(fresh, candidate.id);
    expect(await exists(path.join(fresh, `wiki/articles/${candidate.slug}.md`))).toBe(true);
  });
});
