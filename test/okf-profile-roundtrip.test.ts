/**
 * @file The END-TO-END profile-aware OKF round-trip proof (CLP 7.6 Task 6), research
 * profile. A research project's live typed pages + relation graph + workflow run are
 * exported to an OKF bundle and re-imported TRUSTED into a FRESH research project
 * (same profile installed), proving:
 *
 *  - every typed doc promotes LIVE at `wiki/<entityType>/<slug>.md` through the trust
 *    planner (never the legacy `writeAll`): no `mismatch-fallback`, every outcome
 *    `promoted-typed`;
 *  - domain frontmatter fields + the non-initial lifecycle state survive verbatim
 *    (the Part-A export gap fix);
 *  - relations round-trip through the validated relation store (`readRelations`);
 *  - the workflow-run summary is VISIBLE in the report yet INERT — no run is
 *    materialized into the fresh project's `.llmwiki/workflows/runs` (D-7.6.7);
 *  - re-exporting the fresh project reproduces the same entity docs + relation tuples.
 *
 * A separate proof covers the honest v0 lifecycle semantics: a page whose entered
 * state carries an unsatisfiable relation precondition is REFUSED promotion and
 * retained for review (fail to review, never fail open).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { readRelations } from "../src/relations/store-read.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { runOkfImport, type OkfImportReport } from "../src/import/run.js";
import { installResearchProfile, buildResearchProject, seedResearchRelations } from "./fixtures/research-profile.js";
import {
  buildImportableResearchProject, seedWorkflowRun, exportBundle, importBundle,
  bundleRelationTuples, readBundleDoc, GATED_EXPERIMENT_SLUG,
} from "./fixtures/okf-roundtrip-helpers.js";

/** True when a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("research profile-aware OKF round-trip (trusted)", () => {
  let src: string, fresh: string, bundle: string, report: OkfImportReport;
  beforeAll(async () => {
    src = await mkdtemp(path.join(tmpdir(), "okf-rt-src-"));
    await buildImportableResearchProject(src);
    await seedWorkflowRun(src);
    bundle = await exportBundle(src);
    fresh = await mkdtemp(path.join(tmpdir(), "okf-rt-fresh-"));
    await installResearchProfile(fresh);
    report = await importBundle(fresh, bundle, true);
  });
  afterAll(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
  });

  it("promotes every typed doc live via the planner — no writeAll fallback", () => {
    expect(report.typed!.length).toBeGreaterThan(0);
    expect(report.typed!.every((t) => t.outcome === "promoted-typed")).toBe(true);
    expect(report.typed!.some((t) => t.outcome === "mismatch-fallback")).toBe(false);
  });

  it("lands papers/<slug>.md with domain fields + the non-initial lifecycle state preserved", async () => {
    const file = path.join(fresh, "wiki/papers/attention-is-all-you-need.md");
    expect(await exists(file)).toBe(true);
    const { meta } = parseFrontmatter(await readFile(file, "utf-8"));
    expect(meta.title).toBe("Attention Is All You Need");
    expect(meta.authors).toEqual(["Vaswani", "Shazeer"]);
    expect(meta.year).toBe(2017);
    expect(meta.venue).toBe("NeurIPS");
    expect(meta.stage).toBe("distilled"); // non-initial terminal state round-trips
    expect(meta.distilledSummary).toBeDefined();
  });

  it("round-trips relations through the validated store (readRelations)", async () => {
    expect(report.relationOutcomes!.every((r) => r.outcome === "imported")).toBe(true);
    const { relations } = await readRelations(fresh);
    const cites = relations.find((r) => r.type === "cites" && r.from === "papers/attention-is-all-you-need");
    expect(cites!.to).toBe("sources/transformer-reference-repo");
  });

  it("surfaces the workflow-run summary yet materializes no runs (inert, D-7.6.7)", async () => {
    expect(report.bundleWorkflows).toBeDefined();
    expect(report.bundleWorkflows!.count).toBe(1);
    const runsDir = path.join(fresh, ".llmwiki/workflows/runs");
    const runs = await readdir(runsDir).catch(() => [] as string[]);
    expect(runs.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("re-exports the same entity doc paths + relation tuples", async () => {
    const reexport = await exportBundle(fresh, path.join(fresh, "reexport"));
    expect(await bundleRelationTuples(reexport)).toEqual(await bundleRelationTuples(bundle));
    const doc = await readBundleDoc(reexport, "papers/attention-is-all-you-need.md");
    const x = doc["x-llmwiki"] as Record<string, unknown>;
    expect(x.entityType).toBe("papers");
    expect(x.lifecycle).toEqual({ field: "stage", state: "distilled" });
  });
});

describe("research OKF import — gated lifecycle state refuses promotion (honest v0)", () => {
  // Lifecycle semantics found (documented per Task 6): a NEW page (no prior on-disk
  // state) may enter ANY declared state on create — the FSM exempts creates from the
  // transition-edge check — provided its required evidence fields are present. It is
  // ONLY refused when the entered state carries a RELATION/artifact precondition that
  // is unmet at promotion time. Typed pages promote BEFORE the relation leg, so the
  // `complete` experiment's `tests`→idea precondition is unmet: it is RETAINED as a
  // typed candidate (`staged-typed`, promotion-refused), never written live.
  it("keeps a relation-gated complete experiment staged, not live", async () => {
    const src = await mkdtemp(path.join(tmpdir(), "okf-rt-gated-src-"));
    const fresh = await mkdtemp(path.join(tmpdir(), "okf-rt-gated-fresh-"));
    try {
      await buildResearchProject(src);
      await seedResearchRelations(src);
      await exportBundle(src);
      await installResearchProfile(fresh);
      const report = await runOkfImport(fresh, path.join(src, "bundle"), { trusted: true });
      const gated = report.typed!.find((t) => t.slug === GATED_EXPERIMENT_SLUG)!;
      expect(gated.outcome).toBe("staged-typed");
      expect(gated.reason).toContain("promotion-refused");
      expect(await exists(path.join(fresh, `wiki/experiments/${GATED_EXPERIMENT_SLUG}.md`))).toBe(false);
      const retained = await listCandidates(fresh);
      expect(retained.some((c) => c.slug === GATED_EXPERIMENT_SLUG)).toBe(true);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
