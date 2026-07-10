/**
 * @file test/research-profile.test.ts
 * @description Read-surface proof for the first REAL domain profile — `research`.
 *
 * Installs the {@link RESEARCH_PROFILE} pack as a fixture project's
 * `.llmwiki/profile.json` (five typed entity types + three typed relations, each
 * type seeded with real pages) and proves every READ surface handles the typed
 * pages/relations correctly: profile `validate` (clean), `status` (per-type
 * entity counts + relation presence), `lint` (no spurious findings), `export`
 * (typed pages + relations in the profile block), the viewer counts/graph (typed
 * nodes + relation edges), and the context pool (typed pages rankable +
 * graph-reachable). CLI-exercisable criteria are proven at the subprocess level;
 * the rest in-process. This slice adds NO engine capability — it is config +
 * fixtures + this proof, so the default path is untouched.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import { createWiki } from "../src/index.js";
import { lint } from "../src/linter/index.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { buildContextPack } from "../src/context/build.js";
import { EXPORT_DIR } from "../src/utils/constants.js";
import { validateProfile } from "../src/profile/validate.js";
import { runCLI } from "./fixtures/run-cli.js";
import {
  buildResearchProject,
  seedResearchRelations,
  RESEARCH_ENTITY_TYPES,
  RESEARCH_RELATION_TYPES,
  RESEARCH_PROFILE,
} from "./fixtures/research-profile.js";

let root = "";

/** The per-type entity page counts the seeded superset fixture yields. */
const EXPECTED_ENTITY_COUNTS = {
  papers: 2, sources: 2, ideas: 2, experiments: 2, manuscripts: 2,
  topics: 1, "research-concepts": 1, methods: 2, foundations: 1,
  people: 1, reviews: 1, "research-outputs": 1,
};

/** The per-type live relation counts the seeded superset fixture yields. */
const EXPECTED_RELATION_COUNTS = {
  cites: 2, "builds-on": 2, tests: 1,
  challenges: 1, "introduces-concept": 1, "uses-concept": 1,
  "proposes-method": 1, "extends-method": 1, supports: 1,
  contradicts: 1, "derived-from": 1, "addresses-gap": 1,
};

/** Fixture totals, derived from the per-type counts so they can never drift. */
const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);
const EXPECTED_PAGE_TOTAL = sum(EXPECTED_ENTITY_COUNTS);
const EXPECTED_RELATION_TOTAL = sum(EXPECTED_RELATION_COUNTS);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "research-profile-"));
  await buildResearchProject(root);
  await seedResearchRelations(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("research profile — validate (clean)", () => {
  it("profile validate exits 0 for the installed research profile", async () => {
    const result = await runCLI(["profile", "validate"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid");
  });

  it("profile show prints the research id and all twelve relation types", async () => {
    const result = await runCLI(["profile", "show"], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("research");
    expect(result.stdout).toMatch(/relations:\s+12/);
  });

  it("declares all 7 research artifact types (types only — no required-artifact precondition)", async () => {
    const { profile } = validateProfile(RESEARCH_PROFILE);
    expect(Object.keys(profile.artifacts ?? {}).sort()).toEqual([
      "experiment-plan", "experiment-result", "manuscript-draft",
      "paper-source-metadata", "rebuttal-response", "review-packet", "run-log",
    ]);
    // No lifecycle declares an artifact-existence precondition in this slice (M1).
    for (const def of Object.values(profile.entities)) {
      expect(def.lifecycle && "transitionArtifactRequirements" in def.lifecycle).toBeFalsy();
    }
  });
});

describe("research profile — status (entity counts + relation presence)", () => {
  it("reports per-type entity counts for all twelve entity types", async () => {
    const result = await collectStatus(root);
    expect(result.profile?.profileId).toBe("research");
    expect(result.profile?.entityCounts).toEqual(EXPECTED_ENTITY_COUNTS);
  });

  it("reports live relation counts per type and the total", async () => {
    const result = await collectStatus(root);
    expect(result.profile?.relationCounts).toEqual(EXPECTED_RELATION_COUNTS);
    expect(result.profile?.relationTotal).toBe(EXPECTED_RELATION_TOTAL);
  });

  it("surfaces no problems for the clean fixture", async () => {
    const result = await collectStatus(root);
    expect(result.profile && "problems" in result.profile).toBe(false);
  });

  it("lifecycle-state totals equal entity counts (proves every page is enrolled in its FSM)", async () => {
    const result = await collectStatus(root);
    const states = result.profile?.lifecycleStates ?? {};
    for (const type of RESEARCH_ENTITY_TYPES) {
      const enrolled = Object.values(states[type] ?? {}).reduce((a, b) => a + b, 0);
      expect(enrolled).toBe(EXPECTED_ENTITY_COUNTS[type]);
    }
  });
});

describe("research profile — lint (no spurious problems)", () => {
  it("in-process lint reports no profile findings for the clean project", async () => {
    const { results } = await lint(root);
    expect(results.filter((r) => r.rule.startsWith("profile/"))).toHaveLength(0);
    expect(results.some((r) => r.rule === "empty-page")).toBe(false);
    expect(results.some((r) => r.severity === "error")).toBe(false);
  });

  it("lint CLI exits 0 on the clean research project", async () => {
    const result = await runCLI(["lint"], root);
    expect(result.code).toBe(0);
  });

  it("lint FLAGS a typed page that breaks its field contract (negative control — proves lint inspects typed pages)", async () => {
    // Drop the required `title` from a papers page. If lint catches it, the clean
    // passes above are clean-because-valid, not clean-because-lint-ignores-the-profile.
    await writeFile(
      path.join(root, "wiki/papers/scaling-laws.md"),
      "---\nauthors:\n  - Kaplan\nstage: triaged\ntriageNote: note\n---\n\nBody about scaling laws.\n",
      "utf8",
    );
    const { results } = await lint(root);
    const profileFindings = results.filter((r) => r.rule.startsWith("profile/"));
    expect(profileFindings.length).toBeGreaterThan(0);
    expect(profileFindings.some((r) => r.entityType === "papers")).toBe(true);
  });

  it("lint FLAGS a page that omits the required lifecycle field (proves enrollment is mandatory)", async () => {
    // A page with no `stage` would silently opt out of its FSM (an absent lifecycle
    // field is exempt on create); `stage: required` must turn that into a
    // field-contract violation so no page can dodge a future gated state.
    await writeFile(
      path.join(root, "wiki/ideas/curriculum-pretraining.md"),
      "---\ntitle: Curriculum Pretraining\nrationale: Ordering data may speed convergence.\n---\n\nBody about curriculum pretraining.\n",
      "utf8",
    );
    const { results } = await lint(root);
    const profileFindings = results.filter((r) => r.rule.startsWith("profile/"));
    expect(profileFindings.some((r) => r.entityType === "ideas")).toBe(true);
  });
});

describe("research profile — export (typed pages + relations)", () => {
  it("exportJson carries every typed page in the profile block", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.profileId).toBe("research");
    expect(doc.profile?.entityPages).toHaveLength(EXPECTED_PAGE_TOTAL);
    const types = new Set(doc.profile?.entityPages.map((p) => p.entityType));
    for (const type of RESEARCH_ENTITY_TYPES) expect(types.has(type)).toBe(true);
    expect(doc.profile && "problems" in doc.profile).toBe(false);
  });

  it("exportJson carries every seeded relation type in the profile block", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.relations).toHaveLength(EXPECTED_RELATION_TOTAL);
    const relTypes = new Set(doc.profile?.relations?.map((r) => r.type));
    for (const type of RESEARCH_RELATION_TYPES) expect(relTypes.has(type)).toBe(true);
  });

  it("export CLI writes a JSON bundle carrying the typed profile block", async () => {
    const result = await runCLI(["export", "--target", "json"], root);
    expect(result.code).toBe(0);
    const raw = await readFile(path.join(root, EXPORT_DIR, "wiki.json"), "utf8");
    const doc = JSON.parse(raw);
    expect(doc.profile.profileId).toBe("research");
    expect(doc.profile.entityPages).toHaveLength(EXPECTED_PAGE_TOTAL);
    expect(doc.profile.relations).toHaveLength(EXPECTED_RELATION_TOTAL);
  });

  it("OKF export emits typed profile entity docs and the bundle-level profile block", async () => {
    const out = path.join(await mkdtemp(path.join(os.tmpdir(), "research-okf-")), "okf");
    const report = await createWiki({ root }).exportOkf({ out });
    expect(report.writtenPaths.length).toBeGreaterThan(0);
    // Profile-aware OKF: the bundle carries one doc per typed entity page at
    // `<entityType>/<slug>.md` (e.g. the seeded `research-outputs` release, whose
    // body carries the distinctive "mixture-of-experts" token) with an
    // `entityType` marker (7.6 Task 1), AND the bundle-level `x-llmwiki.profile`
    // metadata block on index.md carrying the `profileId` (7.6 Task 2).
    const outputDoc = `${path.sep}research-outputs${path.sep}moe-model-release.md`;
    expect(report.writtenPaths.some((p) => p.endsWith(outputDoc))).toBe(true);
    const emitted = (
      await Promise.all(report.writtenPaths.map((p) => readFile(p, "utf8")))
    ).join("\n");
    expect(emitted).toMatch(/entityType: research-outputs/);
    expect(emitted).toContain("mixture-of-experts");
    expect(emitted).toMatch(/profileId: research/);
    await rm(path.dirname(out), { recursive: true, force: true });
  });
});

describe("research profile — viewer counts/graph", () => {
  it("viewer snapshot reports per-type entity counts", async () => {
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.profile?.profileId).toBe("research");
    expect(snapshot.profile?.entityCounts).toEqual(EXPECTED_ENTITY_COUNTS);
  });

  it("viewer graph surfaces typed entity nodes and relation edges", async () => {
    const snapshot = await buildViewerSnapshot(root);
    const entityNodes = snapshot.graph.nodes.filter((n) => n.nodeKind === "entity");
    expect(entityNodes).toHaveLength(EXPECTED_PAGE_TOTAL);
    const relationEdges = snapshot.graph.edges.filter((e) => e.edgeKind === "relation");
    expect(relationEdges).toHaveLength(EXPECTED_RELATION_TOTAL);
    const relTypes = new Set(relationEdges.map((e) => e.relationType));
    for (const type of RESEARCH_RELATION_TYPES) expect(relTypes.has(type)).toBe(true);
  });
});

describe("research profile — context pool", () => {
  it("ranks a typed entity page into primary[] for a matching prompt", async () => {
    const pack = await buildContextPack({ root, prompt: "MixtureOfExperts" });
    const ids = pack.primary.map((p) => p.id as unknown as string);
    expect(ids).toContain("ideas/sparse-routing");
  });

  it("surfaces a relation neighbor of a ranked typed page in neighbors[]", async () => {
    const pack = await buildContextPack({ root, prompt: "MixtureOfExperts", depth: 1 });
    const neighborIds = pack.neighbors.map((n) => n.to as unknown as string);
    expect(neighborIds).toContain("papers/attention-is-all-you-need");
  });
});
