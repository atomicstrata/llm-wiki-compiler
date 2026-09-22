/**
 * @file test/preparations/lifecycle-model/frozen-regressions.test.ts
 * @description Enforces the frozen Task 9 regression corpus across the lifecycle
 * authority migration.
 *
 * Sixteen adversarial rounds are encoded in these scenarios and the migration rewrites
 * the code they exercise, so the dominant risk is a hardened attack quietly weakening
 * during a refactor. Freezing titles alone would not catch that: every assertion could
 * be replaced with a tautology and the title would still be there. So each scenario's
 * BODY is digested and asserted. A slice that legitimately changes what an attack
 * proves must update this manifest deliberately, which is exactly the explicit
 * disposition the migration requires — the friction is the feature.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FROZEN_EVIDENCE_CLASSES, FROZEN_OPERATIONS, FROZEN_REGRESSIONS, OPERATION_DRIVERS,
  FROZEN_CLASSIFICATION_DIGEST, FROZEN_REGRESSION_BASELINE, FROZEN_REGRESSION_SCENARIO_COUNT,
  SHARED_CONSUMER_ENTRY_POINTS,
} from "./frozen-regressions.js";
import { scenarioBodies, scenarioReach } from "./reach.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
type FrozenScenario = (typeof FROZEN_REGRESSIONS)[number]["scenarios"][number];

/** Where a frozen case's named production entry point must actually be exported from. */
const PRODUCTION_DIRECTORIES = ["src/preparations", "src/utils"];

/** Current scenarios of one corpus file, keyed by title. */
async function currentScenarios(relativePath: string): Promise<Map<string, string>> {
  const text = await readFile(path.join(REPO_ROOT, relativePath), "utf8");
  return new Map(scenarioBodies(relativePath, text).map((scenario) => [scenario.title, scenario.body]));
}

describe("frozen Task 9 regression corpus", () => {
  it("assigns every frozen scenario a unique stable id and a body digest", () => {
    const scenarios = FROZEN_REGRESSIONS.flatMap<FrozenScenario>((file) => file.scenarios);
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^PLA-REG-[A-Z]+-\d{3}$/.test(id))).toBe(true);
    expect(scenarios.every((scenario) => /^[0-9a-f]{64}$/.test(scenario.bodySha256))).toBe(true);
    expect(FROZEN_REGRESSION_BASELINE).toMatch(/^[0-9a-f]{40}$/);
    expect(scenarios.length).toBe(FROZEN_REGRESSION_SCENARIO_COUNT);
  });

  it("still contains every frozen scenario, none renamed or removed", async () => {
    const missing: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const current = await currentScenarios(file.path);
      for (const scenario of file.scenarios) {
        if (!current.has(scenario.title)) missing.push(`${file.path} :: ${scenario.id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("preserves the body of every frozen scenario", async () => {
    // A changed body means a historical attack now proves something different. That may
    // be legitimate, but it requires updating this manifest in the slice PR rather than
    // happening silently as a side effect of a refactor.
    const changed: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const current = await currentScenarios(file.path);
      for (const scenario of file.scenarios) {
        const body = current.get(scenario.title);
        if (body === undefined) continue; // reported by the identity test above
        const digest = createHash("sha256").update(body, "utf8").digest("hex");
        if (digest !== scenario.bodySha256) changed.push(`${file.path} :: ${scenario.id}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it("preserves the whole of every corpus file, helpers and fixtures included", async () => {
    // Body digests alone leave shared helpers and lifecycle-fixture.ts unprotected, and
    // that fixture owns no scenario while most of the corpus asserts through it — so an
    // assertion could be weakened there without tripping any per-scenario check.
    const changed: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const text = await readFile(path.join(REPO_ROOT, file.path), "utf8");
      const digest = createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
      if (digest !== file.fileSha256) changed.push(file.path);
    }
    expect(changed).toEqual([]);
  });

  it("classifies every frozen case by operation and evidence class", () => {
    // Without these, the corpus records THAT a case exists but not what kind of evidence
    // it is, so the mix could drift from adversarial toward happy-path unnoticed.
    const scenarios = FROZEN_REGRESSIONS.flatMap<FrozenScenario>((file) => file.scenarios);
    const wrong = scenarios.filter((scenario) =>
      !FROZEN_OPERATIONS.includes(scenario.operation) || !FROZEN_EVIDENCE_CLASSES.includes(scenario.evidence));
    expect(wrong.map((scenario) => scenario.id)).toEqual([]);
    // The corpus exists to hold destructive hardening, so it must stay mostly adversarial
    // and durability evidence rather than drifting into happy-path coverage.
    const hardening = scenarios.filter((s) => s.evidence === "adversarial" || s.evidence === "durability");
    expect(hardening.length).toBeGreaterThan(scenarios.length / 2);
  });

  it("agrees, for every frozen case, between its operation and its entry point", () => {
    // Enum membership alone let a case be relabelled from purge to reset with the whole
    // suite still green — which is how three records ended up misclassified. Binding the
    // operation to the driver it must be exercised through makes the label falsifiable:
    // a case claiming an operation reaches that operation's driver, and a case claiming
    // `shared` reaches no destructive driver at all (or it was mislabelled).
    const drivers = new Set<string>(Object.values(OPERATION_DRIVERS));
    const disagreeing = FROZEN_REGRESSIONS.flatMap<FrozenScenario>((file) => file.scenarios).filter((scenario) => {
      const expected = OPERATION_DRIVERS[scenario.operation as keyof typeof OPERATION_DRIVERS];
      return expected === undefined
        ? drivers.has(scenario.reachesProduction)
        : scenario.reachesProduction !== expected;
    });
    expect(disagreeing.map((scenario) => `${scenario.id}: ${scenario.operation}/${scenario.reachesProduction}`)).toEqual([]);
  });

  it("freezes the reviewed classification of every case", () => {
    // Subject versus setup is a human judgement that no static rule can recover: almost
    // every scenario legitimately calls a driver, a consumer AND a helper, so any
    // inference rule is satisfiable by relabelling a case to another category it also
    // touches. Freezing the reviewed answer is what makes a reclassification a
    // deliberate, reviewable edit rather than something that slips through whichever
    // static check happens to be weakest.
    const rows = FROZEN_REGRESSIONS.flatMap<FrozenScenario>((file) => file.scenarios).map((scenario) =>
      [scenario.id, scenario.operation, scenario.evidence, scenario.reachesProduction].join(" "));
    const digest = createHash("sha256").update(rows.join("|"), "utf8").digest("hex");
    expect(digest, "classification changed; if intended, review each record and update "
      + "FROZEN_CLASSIFICATION_DIGEST in the same commit").toBe(FROZEN_CLASSIFICATION_DIGEST);
  });

  it("grants the shared exemption only to a real cross-cutting consumer", () => {
    // `shared` is an exemption from both cross-authority checks, so it cannot be a
    // free-form label. Requiring one of a closed set of consumer entry points is what
    // stops an ambiguous case from being relabelled `shared` with an incidental helper —
    // a path builder is genuinely called and genuinely exported, and proves nothing.
    const allowed = new Set<string>(SHARED_CONSUMER_ENTRY_POINTS);
    const unjustified = FROZEN_REGRESSIONS.flatMap<FrozenScenario>((file) => file.scenarios)
      .filter((scenario) => scenario.operation === "shared" && !allowed.has(scenario.reachesProduction));
    expect(unjustified.map((scenario) => `${scenario.id} -> ${scenario.reachesProduction}`)).toEqual([]);
  });

  it("names, for every frozen case, a production entry point the case actually reaches", async () => {
    // reachesProduction must resolve the same way a coverage citation does: the named
    // export has to be CALLED within the scenario's own reach. A fixture-only helper or
    // an export the file merely imports is not production reach.
    const unreached: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const text = await readFile(path.join(REPO_ROOT, file.path), "utf8");
      const reach = new Map(scenarioReach(file.path, text).map((s) => [s.title, s.calls]));
      for (const scenario of file.scenarios) {
        const calls = reach.get(scenario.title);
        if (calls === undefined) continue; // reported by the identity test above
        if (!calls.has(scenario.reachesProduction)) {
          unreached.push(`${scenario.id} does not call ${scenario.reachesProduction}`);
        }
      }
    }
    expect(unreached).toEqual([]);
  });

  it("resolves every named production entry point to a real src/ export", async () => {
    // Guards the other direction: a plausible-looking name that no longer exists in
    // production would otherwise sit in the manifest forever as decoration.
    const named = [...new Set(FROZEN_REGRESSIONS.flatMap((f) => f.scenarios.map((s) => s.reachesProduction)))];
    const sources = await Promise.all(PRODUCTION_DIRECTORIES.map(async (directory) => {
      const dir = path.join(REPO_ROOT, directory);
      const names = await readdir(dir);
      const texts = await Promise.all(names.filter((n) => n.endsWith(".ts"))
        .map((n) => readFile(path.join(dir, n), "utf8")));
      return texts.join("\n");
    }));
    const production = sources.join("\n");
    const missing = named.filter((name) =>
      !new RegExp(`export (?:async )?function ${name}\\b`).test(production));
    expect(missing).toEqual([]);
  });

  it("never lets a corpus file shrink below its frozen scenario count", async () => {
    const shrunk: string[] = [];
    for (const file of FROZEN_REGRESSIONS) {
      const current = await currentScenarios(file.path);
      if (current.size < file.scenarios.length) {
        shrunk.push(`${file.path}: ${current.size} < ${file.scenarios.length}`);
      }
    }
    expect(shrunk).toEqual([]);
  });
});
