/**
 * @file test/preparation-service-show-unreadable.test.ts
 * @description "could not read" and "does not qualify" are OPPOSITE answers, and
 * `show` used to give the same one to both.
 *
 * THE EXIT CODE IS WHY THIS MATTERS RATHER THAN BEING A WORDING PREFERENCE. The
 * shipped contract is three outcomes and three codes: 0 described, 1 a settled
 * fact about the store, 2 a fact about this OBSERVER, so a script can retry on 2
 * and report on 1. The project-readiness leg honoured it; the run lookup did not.
 * Its failures — a degraded manifest scan that says in its own message "this run
 * may exist", an unreadable key, a corrupt run leaf — all arrived as one untyped
 * `{ok:false, reason}` and rendered as `refused`, so the CLI exited 1 and every
 * retrying script gave up on a run that was sitting right there.
 *
 * FOUR LEGS, MEASURED SEPARATELY, because "show returns unavailable" can be
 * satisfied by one leg while three others stay collapsed. Each case below breaks
 * exactly one thing and names which leg answers.
 *
 * AND THE DENIAL IS PINNED BESIDE THEM. A fix that answered `unavailable` for
 * everything would satisfy every unavailability case here and be just as wrong in
 * the other direction — an operator told to retry a run that genuinely does not
 * exist retries forever. The absent-leaf case is the green half that makes the red
 * half mean something: it was run against an over-eager mutant and it fails there.
 */

import { describe, expect, it } from "vitest";
import { chmod, rm, writeFile, readFile } from "node:fs/promises";
import { useTempRoot } from "./fixtures/temp-root.js";
import { runCLI } from "./fixtures/run-cli.js";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationServiceV1, ShowResultV1 } from "../src/preparations/service.js";
import { preparationKeyFile, preparationPaths } from "../src/preparations/paths.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import { stageBoundPreparation } from "./preparations/store-fixture.js";

const root = useTempRoot();

/** The exit code reserved for "this observer could not see". */
const UNAVAILABLE_EXIT = 2;
/** The exit code for a settled fact about the store. */
const DENIED_EXIT = 1;

/** A service on the local-operator surface, as the CLI host constructs one. */
function serviceFor(dir: string): PreparationServiceV1 {
  return createPreparationService({
    root: dir, surface: "cli",
    principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: [] }) },
  });
}

/** Break the manifest so the inventory scan reports a problem and drops it. */
async function corruptManifest(dir: string, binding: PreparationRunBinding): Promise<void> {
  const paths = preparationPaths(dir, binding.workspaceId);
  await writeFile(paths.manifestFile(binding.preparationId), "{ not json", "utf8");
}

/** Flip one bit of the run leaf's integrity tag, leaving the file readable. */
async function corruptRunLeaf(dir: string, binding: PreparationRunBinding): Promise<void> {
  const file = preparationPaths(dir, binding.workspaceId).runFile(binding.runId);
  const record = JSON.parse(await readFile(file, "utf8")) as { integrity: string };
  record.integrity = `${record.integrity.slice(0, -1)}${record.integrity.endsWith("0") ? "1" : "0"}`;
  await writeFile(file, JSON.stringify(record), "utf8");
}

/** Remove the run leaf entirely — the one genuine absence in this file. */
async function removeRunLeaf(dir: string, binding: PreparationRunBinding): Promise<void> {
  await rm(preparationPaths(dir, binding.workspaceId).runFile(binding.runId));
}

/** Show the staged run after one fault has been introduced. */
async function showAfter(
  fault: (dir: string, binding: PreparationRunBinding) => Promise<void>,
): Promise<ShowResultV1> {
  const binding = await stageBoundPreparation(root.dir);
  await fault(root.dir, binding);
  return serviceFor(root.dir).show({ runId: binding.runId });
}

describe("show reports could-not-read as unavailable, at every lookup leg", () => {
  it("a degraded manifest scan — the miss is not evidence of absence", async () => {
    // THE SCAN DROPS WHAT IT CANNOT READ, so "not in the list" over a scan with
    // problems means could-not-see. The shipped message already said so.
    expect(await showAfter(corruptManifest)).toMatchObject({
      status: "unavailable",
      detail: "the preparation scan was not authoritative; this run may exist",
    });
  });

  it("an absent preparation key — a torn store, not a fact about the run", async () => {
    // THE LOOKUP'S KEY LEG, reached because readiness passes: the key file is
    // gone rather than unreadable, and the binding that authenticates a run read
    // cannot be built without it. Absence of the authenticator says nothing about
    // whether the run exists.
    expect(await showAfter(async (dir) => rm(preparationKeyFile(dir)))).toMatchObject({
      status: "unavailable", detail: "preparation key is absent",
    });
  });

  it("a corrupt run leaf — this observer could not read an intact-looking run", async () => {
    expect(await showAfter(corruptRunLeaf)).toMatchObject({
      status: "unavailable", detail: "run is unreadable: run-integrity-invalid",
    });
  });

  it("an unreadable key, refused by the PROJECT leg before the lookup", async () => {
    // A DIFFERENT LEG, and labelled as one. A key whose mode is wrong fails the
    // project-readiness check, which already answered `unavailable` before this
    // slice — so this case does NOT witness the lookup taxonomy and goes green
    // against a mutant that collapses it. It is kept because the leg is real and
    // its ordering is what makes the lookup's own key branch hard to reach.
    expect(await showAfter(async (dir) => chmod(preparationKeyFile(dir), 0o644)))
      .toMatchObject({ status: "unavailable" });
  });
});

describe("show still denies what is genuinely absent", () => {
  it("an absent run leaf is refused, not reported as unreadable", async () => {
    expect(await showAfter(removeRunLeaf)).toMatchObject({
      status: "refused", reason: "run is unreadable: absent",
    });
  });
});

/** Stage a run, break one thing, and ask the real binary about it. */
async function showThroughBinary(
  fault: (dir: string, binding: PreparationRunBinding) => Promise<void>,
): Promise<{ code: number; envelope: Record<string, unknown> }> {
  const binding = await stageBoundPreparation(root.dir);
  await fault(root.dir, binding);
  const result = await runCLI(["preparation", "show", binding.runId, "--json"], root.dir);
  return { code: result.code, envelope: JSON.parse(result.stdout) as Record<string, unknown> };
}

describe("the exit codes an operator's script actually branches on", () => {
  it("exits 2 for a degraded scan, so a retrying script keeps retrying", async () => {
    const { code, envelope } = await showThroughBinary(corruptManifest);
    expect(code).toBe(UNAVAILABLE_EXIT);
    expect(envelope).toMatchObject({ status: "unavailable" });
  });

  it("exits 2 for an absent key", async () => {
    const { code, envelope } = await showThroughBinary(async (dir) => rm(preparationKeyFile(dir)));
    expect(code).toBe(UNAVAILABLE_EXIT);
    expect(envelope).toMatchObject({ status: "unavailable" });
  });

  it("exits 2 for a corrupt run leaf", async () => {
    const { code, envelope } = await showThroughBinary(corruptRunLeaf);
    expect(code).toBe(UNAVAILABLE_EXIT);
    expect(envelope).toMatchObject({ status: "unavailable" });
  });

  it("exits 1 for a genuinely absent run — the code that means stop retrying", async () => {
    const { code, envelope } = await showThroughBinary(removeRunLeaf);
    expect(code).toBe(DENIED_EXIT);
    expect(code).not.toBe(UNAVAILABLE_EXIT);
    expect(envelope).toMatchObject({ status: "refused" });
  });
});
