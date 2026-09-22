/**
 * @file test/preparations/lifecycle-model/coverage-matrix.test.ts
 * @description Proves the finite lifecycle model is closed rather than sampled.
 *
 * The failure this guards against is specific and historical: every review round found
 * a new unchecked cell, because the suite grew one example per reported exploit while
 * nothing required the space itself to be covered. These assertions fail when a
 * dimension value, a consumer's pending/unavailable behaviour, a registry, or a
 * protection-relaxing transition has no proving case — including when a dimension is
 * later extended.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FROZEN_REGRESSION_IDS, FROZEN_REGRESSIONS, OPERATION_DRIVERS } from "./frozen-regressions.js";
import { listFilesUnder } from "./walk.js";
import { scenarioReach } from "./reach.js";
import { scenarioBodyIndex, scenarioTitleIndex } from "./scenario-index.js";
import { LIFECYCLE_COVERAGE_ROWS } from "./coverage-matrix.js";
import {
  LIFECYCLE_CONSUMERS, LIFECYCLE_CRASH_POINTS, LIFECYCLE_FILESYSTEM_STATES,
  LIFECYCLE_OBJECT_STATES, LIFECYCLE_OPERATIONS, LIFECYCLE_PATH_LEVELS,
  LIFECYCLE_RECORD_STATES, LIFECYCLE_REGISTRIES, LIFECYCLE_RELAXATIONS, LIFECYCLE_STATES,
  type LifecycleCoverageRowV1,
} from "./coverage-types.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * The call a test must make to count as exercising a consumer. Consumers reached only
 * through an operation entry point are deliberately absent: there is no single seam
 * that distinguishes them, so claiming one would be the same over-assertion this file
 * exists to prevent.
 */
const CONSUMER_ENTRY_POINTS: Partial<Record<string, string>> = {
  status: "resolvePreparationLifecyclePending",
  recovery: "resolvePreparationLifecyclePending",
  references: "enumeratePreparationReferences",
  gc: "enumeratePreparationReferences",
  capacity: "scanPreparationInventory",
};

/** Dimension values that no row exercises. */
function uncoveredDimensionValues(rows: readonly LifecycleCoverageRowV1[]): string[] {
  const dimensions: readonly (readonly [string, readonly string[], (row: LifecycleCoverageRowV1) => string])[] = [
    ["operation", LIFECYCLE_OPERATIONS, (row) => row.operation],
    ["registry", LIFECYCLE_REGISTRIES, (row) => row.registry],
    ["consumer", LIFECYCLE_CONSUMERS, (row) => row.consumer],
    ["state", LIFECYCLE_STATES, (row) => row.state],
    ["pathLevel", LIFECYCLE_PATH_LEVELS, (row) => row.pathLevel],
    ["filesystemState", LIFECYCLE_FILESYSTEM_STATES, (row) => row.filesystemState],
    ["recordState", LIFECYCLE_RECORD_STATES, (row) => row.recordState],
    ["objectState", LIFECYCLE_OBJECT_STATES, (row) => row.objectState],
    ["crashPoint", LIFECYCLE_CRASH_POINTS, (row) => row.crashPoint],
    ["protectionRelaxation", LIFECYCLE_RELAXATIONS, (row) => row.protectionRelaxation],
  ];
  const missing: string[] = [];
  for (const [name, values, read] of dimensions) {
    const seen = new Set(rows.map(read));
    for (const value of values) if (!seen.has(value)) missing.push(`${name}=${value}`);
  }
  return missing.sort();
}

/** Consumers that lack a pending state or an unavailable state. */
function consumersMissingSafetyStates(rows: readonly LifecycleCoverageRowV1[]): string[] {
  const pendingStates = new Set(["planned", "applying", "awaiting-continuation-intent-only",
    "awaiting-continuation-materialized"]);
  const missing: string[] = [];
  for (const consumer of LIFECYCLE_CONSUMERS) {
    const own = rows.filter((row) => row.consumer === consumer);
    if (!own.some((row) => pendingStates.has(row.state))) missing.push(`${consumer}:pending`);
    if (!own.some((row) => row.state === "unavailable")) missing.push(`${consumer}:unavailable`);
  }
  return missing;
}

/** Shared consumers that read only one physical registry. */
function consumersMissingRegistryParity(rows: readonly LifecycleCoverageRowV1[]): string[] {
  const shared: readonly string[] = ["recovery", "status", "references", "gc"];
  return shared.filter((consumer) => {
    const seen = new Set(rows.filter((row) => row.consumer === consumer).map((row) => row.registry));
    return LIFECYCLE_REGISTRIES.some((registry) => !seen.has(registry));
  });
}

/** Relaxing transitions with no negative case proving evidence is required. */
function unprovedRelaxations(rows: readonly LifecycleCoverageRowV1[]): string[] {
  return LIFECYCLE_RELAXATIONS
    .filter((relaxation) => relaxation !== "none")
    .filter((relaxation) => !rows.some((row) => row.protectionRelaxation === relaxation));
}

describe("finite lifecycle coverage model", () => {
  it("covers every closed dimension value", () => {
    expect(uncoveredDimensionValues(LIFECYCLE_COVERAGE_ROWS)).toEqual([]);
  });

  it("covers pending and unavailable for every consumer", () => {
    expect(consumersMissingSafetyStates(LIFECYCLE_COVERAGE_ROWS)).toEqual([]);
  });

  it("covers both registries for shared consumers", () => {
    expect(consumersMissingRegistryParity(LIFECYCLE_COVERAGE_ROWS)).toEqual([]);
  });

  it("covers every protection-relaxing transition negatively", () => {
    expect(unprovedRelaxations(LIFECYCLE_COVERAGE_ROWS)).toEqual([]);
  });

  it("gives every row a unique id", () => {
    const ids = LIFECYCLE_COVERAGE_ROWS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cites titles that identify exactly one scenario in the tree", async () => {
    // Every citation control resolves a row through a scenario TITLE, and the title
    // index is built by `bodies.set(title, calls)` across the whole test tree — so
    // two same-titled scenarios in different files collapse silently, last write
    // winning. A row would then be checked against whichever body happened to be
    // read last and could inherit an unrelated scenario's reach. Only titles the
    // matrix actually cites are policed: the wider tree is free to reuse a title.
    const cited = new Set(LIFECYCLE_COVERAGE_ROWS.map((row) => row.provingTestId));
    const seen = new Map<string, string[]>();
    for (const file of await listFilesUnder(REPO_ROOT, "test", ".test.ts")) {
      const source = await readFile(path.join(REPO_ROOT, file), "utf8");
      for (const scenario of scenarioReach(file, source)) {
        if (cited.has(scenario.title)) {
          seen.set(scenario.title, [...seen.get(scenario.title) ?? [], file]);
        }
      }
    }
    const collisions = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([title, files]) => `${title} -> ${files.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("keeps rows citing one scenario from contradicting each other", () => {
    // One scenario has ONE world state, so two rows citing it must agree about what
    // that state was. Disagreement proves at least one row wrong without needing to
    // know which — which is why this needs no parse of the scenario body.
    //
    // WHAT THIS CANNOT DO, stated because the obvious reading is wrong: it catches a
    // row that DISAGREES with a sibling, never a wrong row that AGREES. The defect
    // that motivated it is itself invisible here. At the task baseline, PLA-CASE-059
    // and PLA-CASE-055 cited the same scenario with IDENTICAL world states, differing
    // only in consumer — 059 was authored by copying a correct row and changing the
    // consumer, so the set of states has size one and nothing is reported. That is
    // both the cheapest way to author a row and the one this is blind to.
    //
    // Its reach is also narrow: only rows that share a scenario, which is 10 of 74
    // today. The other 64 cite a scenario exactly once and stay certified by
    // title-existence plus the consumer marker alone.
    //
    // THREE axes are excluded, not two. `consumer` and `pathLevel`, because one
    // scenario legitimately proves several consumers and legitimately touches several
    // path levels — a receipt and its enclosing unit are both real subjects of one
    // crash, and both exclusions are load-bearing today (033/056 registry vs unit,
    // 061/075 receipt vs unit). `protectionRelaxation` too, because what a consumer
    // relaxes is a property of that consumer rather than of the scenario; it is inert
    // today, since all four multi-row groups are uniformly "none".
    const worldState = (row: LifecycleCoverageRowV1) => [
      row.operation, row.state, row.registry, row.filesystemState,
      row.recordState, row.objectState, row.crashPoint,
    ].join("/");
    const byScenario = new Map<string, LifecycleCoverageRowV1[]>();
    for (const row of LIFECYCLE_COVERAGE_ROWS) {
      byScenario.set(row.provingTestId, [...byScenario.get(row.provingTestId) ?? [], row]);
    }
    const contradictions: string[] = [];
    for (const [scenario, rows] of byScenario) {
      const states = new Set(rows.map(worldState));
      if (states.size > 1) {
        contradictions.push(`${scenario}: ${rows.map((row) => `${row.id}=${worldState(row)}`).join(" vs ")}`);
      }
    }
    expect(contradictions).toEqual([]);
  });

  it("cites only proving tests that actually exist", async () => {
    // A non-empty string proves nothing: a row citing a test that was never written
    // would report the cell covered. Every citation must resolve to a real scenario.
    const known = await scenarioTitleIndex(REPO_ROOT);
    const dangling = LIFECYCLE_COVERAGE_ROWS
      .filter((row) => !known.has(row.provingTestId))
      .map((row) => `${row.id} -> ${row.provingTestId}`);
    expect(dangling).toEqual([]);
  });

  it("cites tests that actually exercise the consumer the row claims", async () => {
    // Reusing one test across four consumers was how the matrix drifted from evidence
    // to decoration: the cited scenario must actually CALL the consumer's entry point,
    // resolved scope-aware, so a same-named binding in a sibling describe block cannot
    // lend its reach to an unrelated scenario.
    const bodies = await scenarioBodyIndex(REPO_ROOT);
    const unproved: string[] = [];
    for (const row of LIFECYCLE_COVERAGE_ROWS) {
      const marker = CONSUMER_ENTRY_POINTS[row.consumer];
      if (marker === undefined) continue; // driver-side consumers have no single seam
      if (!bodies.get(row.provingTestId)?.has(marker)) {
        unproved.push(`${row.id} (${row.consumer}) -> ${row.provingTestId}`);
      }
    }
    expect(unproved).toEqual([]);
  });

  it("agrees with the frozen corpus about a cited scenario's operation", () => {
    // Two authorities described the same scenario and nothing compared them, so a case
    // whose test legitimately calls two drivers could be certified as its SETUP driver
    // here and its real subject there — both internally consistent, jointly wrong. A
    // A `shared` record is exempt because it carries no operation claim to contradict —
    // but that exemption is only sound because the corpus separately requires `shared` to
    // name one of a CLOSED set of cross-cutting consumers. Without that, `shared` would
    // be a free escape from this check rather than a different kind of claim.
    const operations = new Map<string, string>(FROZEN_REGRESSIONS.flatMap((file) =>
      file.scenarios.map((scenario) => [scenario.id, scenario.operation as string])));
    const contradictions = LIFECYCLE_COVERAGE_ROWS.filter((row) => {
      if (row.frozenRegressionId === undefined) return false;
      const frozen = operations.get(row.frozenRegressionId);
      return frozen !== undefined && frozen !== "shared" && frozen !== row.operation;
    });
    expect(contradictions.map((row) =>
      `${row.id}: matrix=${row.operation} corpus=${operations.get(row.frozenRegressionId ?? "")}`)).toEqual([]);
  });

  it("keeps every ambiguous frozen case under the cross-authority check", async () => {
    // The agreement test above only bites on records a matrix row CITES. A scenario that
    // drives two operations — one as setup, one as subject — is exactly where a label can
    // be wrong while every other control passes, so such a case must either carry no
    // operation claim (`shared`, which the corpus constrains to a closed set of
    // cross-cutting consumers) or be cited, and therefore cross-checked.
    const cited = new Set<string>(LIFECYCLE_COVERAGE_ROWS
      .map((row) => row.frozenRegressionId).filter((id) => id !== undefined));
    const drivers = Object.values(OPERATION_DRIVERS);
    const unchecked: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const source = await readFile(path.join(REPO_ROOT, file.path), "utf8");
      const reach = new Map(scenarioReach(file.path, source).map((s) => [s.title, s.calls]));
      for (const scenario of file.scenarios) {
        const driven = drivers.filter((driver) => reach.get(scenario.title)?.has(driver));
        if (driven.length < 2 || scenario.operation === "shared" || cited.has(scenario.id)) continue;
        unchecked.push(`${scenario.id} drives ${driven.length} operations but no row cites it`);
      }
    }
    expect(unchecked).toEqual([]);
  });

  it("cites only frozen regression ids that exist", () => {
    const known = new Set(FROZEN_REGRESSION_IDS);
    const dangling = LIFECYCLE_COVERAGE_ROWS
      .filter((row) => row.frozenRegressionId !== undefined && !known.has(row.frozenRegressionId))
      .map((row) => `${row.id} -> ${row.frozenRegressionId}`);
    expect(dangling).toEqual([]);
  });
});
