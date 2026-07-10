/**
 * @file test/relation-standing-surfaces.test.ts
 * @description Integration coverage for the STANDING-INVARIANT relation-precondition
 * check across ALL FIVE read surfaces (lint, status, export, viewer, context).
 *
 * The write-side enforcer only checks a `transitionRelationRequirements`
 * precondition at the moment a page ENTERS a gated state. Relations are
 * append-only and can later be superseded/compacted/rendered dangling — leaving a
 * page STILL in a gated state whose precondition no longer holds. These tests prove
 * every read surface re-evaluates that standing invariant and reports the drift:
 *
 *  - a CLEAN gated project (page in a gated state WITH its qualifying relation)
 *    reports no standing violation on any surface;
 *  - REMOVING the qualifying relation (deleting the endpoint page so it dangles)
 *    surfaces `lifecycle-relation-requirement-unmet` on all five, with the
 *    actionable entity/type/role/needed-vs-actual detail;
 *  - a GENERIC (structurally-non-research) profile exercises the same check
 *    identically (domain neutrality);
 *  - a corrupt relation store yields `lifecycle-relation-requirement-unverifiable`
 *    on every surface WITHOUT crashing any of them;
 *  - a satisfied gated page and a non-gated page yield no standing problem;
 *  - the built-in default profile yields no standing problem at all.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, rm as rmFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { lintProfileEntities } from "../src/profile/lint.js";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { buildContextPack } from "../src/context/build.js";
import { collectStandingRelationProblems } from "../src/profile/relation-standing.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import { writeProfileFile, writeMarkdownPage, appendRelation, gatedResearchProfile } from "./fixtures/profile-fixtures.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";

const UNMET = "lifecycle-relation-requirement-unmet";
const UNVERIFIABLE = "lifecycle-relation-requirement-unverifiable";
const ALL_FIVE = ["lint", "status", "export", "viewer", "context"] as const;

/** One standing entry as reported by a surface (kind/code + message), surface-agnostic. */
interface StandingEntry {
  code: string;
  message: string;
}

/** The gated RESEARCH profile under test, from the shared fixture (`experiments.complete` gated on `tests`→`ideas`). */
const gatedProfile = gatedResearchProfile;

/**
 * A GENERIC profile with NO research vocabulary: an `alpha.mode` lifecycle whose
 * `sealed` state requires 1 `bonds` relation to a `beta`, over a union-endpoint
 * relation (from/to both accept alpha|beta). Proves the check is domain-neutral.
 */
function genericProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "generic-gated",
    entities: {
      beta: { directory: "wiki/beta", fields: {} },
      alpha: {
        directory: "wiki/alpha",
        requiredFields: ["mode"],
        fields: { title: { type: "string" }, mode: { type: "enum", enum: ["open", "sealed"] } },
        lifecycle: {
          field: "mode",
          initial: "open",
          terminal: ["sealed"],
          transitions: { open: ["sealed"] },
          transitionRelationRequirements: { sealed: [{ relationType: "bonds", role: "from", otherTypes: ["beta"], minCount: 1 }] },
        },
      },
    },
    relations: { bonds: { from: ["alpha", "beta"], to: ["alpha", "beta"], direction: "directed", attributes: {} } },
  } as ProfilePack;
}

/** Map a surface's problem/warning list to standing entries only (unmet + unverifiable). */
function pickStanding(items: Array<{ kind?: string; code?: string; message: string }> | undefined): StandingEntry[] {
  return (items ?? [])
    .map((i) => ({ code: i.kind ?? i.code ?? "", message: i.message }))
    .filter((e) => e.code === UNMET || e.code === UNVERIFIABLE);
}

/** Gather the standing entries reported by each of the five read surfaces. */
async function standingAcrossSurfaces(root: string, profile: ProfilePack): Promise<Record<string, StandingEntry[]>> {
  const lintResults = await lintProfileEntities(root, profile);
  return {
    lint: pickStanding(lintResults.map((r) => ({ code: r.rule, message: r.message }))),
    status: pickStanding((await collectStatus(root)).profile?.problems),
    export: pickStanding((await exportJson(root)).profile?.problems),
    viewer: pickStanding((await buildViewerSnapshot(root)).profile?.problems),
    context: pickStanding((await buildContextPack({ root, prompt: "anything" })).warnings),
  };
}

/** Assert every one of the five surfaces reports an UNMET entry whose message carries all `substrings`. */
function expectUnmetOnAllFive(surfaces: Record<string, StandingEntry[]>, ...substrings: string[]): void {
  for (const surface of ALL_FIVE) {
    const entry = surfaces[surface].find((e) => e.code === UNMET);
    expect(entry, `${surface} must report unmet`).toBeDefined();
    for (const sub of substrings) expect(entry!.message).toContain(sub);
  }
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-standing-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Materialize a clean gated research project: EXP at `complete` WITH its qualifying `tests` relation. */
async function seedCleanResearch(): Promise<void> {
  const pack = gatedProfile();
  await writeProfileFile(root, pack);
  await writeMarkdownPage(root, "wiki/ideas", "real", "---\ntitle: A Real Idea\n---\n\nIdea body.\n");
  await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: An Experiment\nstage: complete\n---\n\nBody.\n");
  await appendRelation(root, pack, { type: "tests", from: "experiments/exp" as EntityId, to: "ideas/real" as EntityId, attributes: { metric: "f1" } });
}

/** Materialize a clean generic project: alpha `a1` at `sealed` WITH its qualifying `bonds` relation to beta `b1`. */
async function seedCleanGeneric(): Promise<void> {
  const pack = genericProfile();
  await writeProfileFile(root, pack);
  await writeMarkdownPage(root, "wiki/beta", "b1", "---\ntitle: Beta One\n---\n\nBeta body.\n");
  await writeMarkdownPage(root, "wiki/alpha", "a1", "---\ntitle: Alpha One\nmode: sealed\n---\n\nAlpha body.\n");
  await appendRelation(root, pack, { type: "bonds", from: "alpha/a1" as EntityId, to: "beta/b1" as EntityId, attributes: {} });
}

describe("standing invariant — research profile across all five surfaces", () => {
  it("a clean gated project reports NO standing violation on any surface", async () => {
    await seedCleanResearch();
    const surfaces = await standingAcrossSurfaces(root, gatedProfile());
    for (const surface of ALL_FIVE) expect(surfaces[surface]).toHaveLength(0);
  });

  it("removing the qualifying relation surfaces UNMET on all five with actionable detail", async () => {
    await seedCleanResearch();
    await rmFile(path.join(root, "wiki/ideas", "real.md")); // endpoint gone → relation dangles
    const surfaces = await standingAcrossSurfaces(root, gatedProfile());
    expectUnmetOnAllFive(surfaces, "experiments/exp", "tests[from] needs 1 but found 0");
  });
});

describe("standing invariant — generic (domain-neutral) profile across all five surfaces", () => {
  it("a clean generic project reports NO standing violation on any surface", async () => {
    await seedCleanGeneric();
    const surfaces = await standingAcrossSurfaces(root, genericProfile());
    for (const surface of ALL_FIVE) expect(surfaces[surface]).toHaveLength(0);
  });

  it("removing the qualifying relation surfaces UNMET on all five (structurally non-research)", async () => {
    await seedCleanGeneric();
    await rmFile(path.join(root, "wiki/beta", "b1.md")); // union-endpoint relation now dangles
    const surfaces = await standingAcrossSurfaces(root, genericProfile());
    expectUnmetOnAllFive(surfaces, "alpha/a1", "bonds[from] needs 1 but found 0");
  });
});

describe("standing invariant — unverifiable, never a crash", () => {
  it("a corrupt relation store yields UNVERIFIABLE on every surface without crashing", async () => {
    const pack = gatedProfile();
    await writeProfileFile(root, pack);
    await writeMarkdownPage(root, "wiki/ideas", "real", "---\ntitle: A Real Idea\n---\n\nIdea body.\n");
    await writeMarkdownPage(root, "wiki/experiments", "exp", "---\ntitle: An Experiment\nstage: complete\n---\n\nBody.\n");
    await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
    // Header parses, then an INTERIOR garbage record (a second garbage line makes
    // the first non-trailing, so it is not tolerated as torn) → RelationStoreCorruptError.
    await writeFile(path.join(root, RELATIONS_FILE), '{"kind":"relation-store-header","schemaVersion":1}\nnot-a-record\nalso-garbage\n', "utf8");
    const surfaces = await standingAcrossSurfaces(root, gatedProfile());
    for (const surface of ALL_FIVE) {
      expect(surfaces[surface].some((e) => e.code === UNVERIFIABLE), `${surface} must report unverifiable`).toBe(true);
    }
  });
});

describe("standing invariant — no false positives", () => {
  it("a non-gated page (state declares no precondition) yields no standing problem", async () => {
    const pack = gatedProfile();
    await writeProfileFile(root, pack);
    await writeMarkdownPage(root, "wiki/experiments", "ng", "---\ntitle: NG\nstage: running\n---\n\nBody.\n");
    const surfaces = await standingAcrossSurfaces(root, gatedProfile());
    for (const surface of ALL_FIVE) expect(surfaces[surface]).toHaveLength(0);
  });

  it("the built-in default profile reads nothing and yields no standing problem", async () => {
    expect(await collectStandingRelationProblems(root, DEFAULT_PROFILE)).toEqual([]);
  });
});
