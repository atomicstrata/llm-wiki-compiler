/**
 * @file test/preparation-service-list-bounds.test.ts
 * @description The design v10 §6 response cap on `list`, which the Task 10
 * reconciliation explicitly PRESERVED and the first implementation omitted.
 *
 * WHAT §6 REQUIRES, and what is implemented: a deterministic response cap
 * following the shipped `MAX_STATUS_LIST = 100` precedent, carrying the true
 * total and a `truncated` flag. Runs and problems are bounded SEPARATELY, each
 * with its own pair — §6 refuses to exempt problems from the cap, because a
 * store's problem list is attacker-influenceable and an exempt set grows toward
 * the 100,000-entry traversal ceiling.
 *
 * WHAT IS DELIBERATELY NOT HERE: pagination. §6 says ship the bound and do not
 * build cursors until a caller must retrieve a complete list.
 *
 * THE STORES ARE REAL, and built the only way the substrate allows. Three
 * shipped caps stand between a test and a hundred-run store — ten preparations
 * per workspace, fifty active nonterminal runs, and the per-call staging cap —
 * so the fixture spreads runs across workspaces and drives each terminal as it
 * goes. That is worth the ~35s it costs: a bound tested against a hand-built
 * projection would be a bound tested against the test's own idea of a listing.
 *
 * THE TRAP THIS FILE ALSO GUARDS. `list` cross-checks the scan's own run count
 * against the rows it produced and reports `run-accounting` when they disagree —
 * the control that stops a silently-empty answer. Capping the rows BEFORE that
 * comparison would fire it on every healthy store above the cap, converting the
 * one honest-answer control into noise.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_PREPARATION_LIST_ITEMS, comparePreparationListing, createPreparationService,
} from "../src/preparations/service.js";
import type { ListResultV1 } from "../src/preparations/service.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";

/** A grant-free reader, which is all `list` needs. */
function reader(root: string) {
  return createPreparationService({
    root, surface: "sdk",
    principals: { principalFor: () => ({ id: "reader", surface: "sdk", grants: [] }) },
  });
}

/**
 * Stage `count` runs into `root`, spread across workspaces and driven terminal.
 *
 * Both moves are forced by shipped caps rather than chosen: preparations are
 * capped at ten per workspace, and active nonterminal runs at fifty globally.
 */
async function stageMany(root: string, count: number, from = 0): Promise<void> {
  const { fixturePlan, stageRequest } = await import("./preparations/store-fixture.js");
  const { stagePreparationLocked } = await import("../src/preparations/stage.js");
  const { driveToFailed } = await import("./preparations/lifecycle-fixture.js");
  const { readPreparationKey } = await import("../src/preparations/key-epoch.js");
  const { preparationManifestDigest } = await import("../src/preparations/manifest-parse.js");
  for (let index = from; index < from + count; index += 1) {
    const plan = fixturePlan((object) => { object.workspaceId = `ws-${Math.floor(index / 8)}`; });
    const staged = await stagePreparationLocked(root, stageRequest(plan));
    if (staged.status !== "staged") throw new Error(`not staged at ${index}: ${staged.status}`);
    const key = await readPreparationKey(root);
    if (key.status !== "ok") throw new Error("no preparation key");
    await driveToFailed(root, {
      runId: staged.manifest.runId, preparationId: staged.manifest.preparationId,
      workspaceId: staged.manifest.workspaceId,
      manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
    } as never);
  }
}

/** Every run id in the store, mapped to the creation time its manifest records. */
async function manifestCreationTimes(root: string): Promise<Map<string, string>> {
  const { scanPreparationInventory } = await import("../src/preparations/capacity.js");
  const inventory = await scanPreparationInventory(root);
  return new Map(inventory.manifests.map((manifest) => [manifest.runId, manifest.createdAt]));
}

/**
 * Delete a workspace's preparation directory, leaving its run leaf.
 *
 * The documented divergence state: the scan still counts the run leaf it can
 * see, while no manifest remains to list it from.
 */
async function deletePreparationDirectory(root: string, workspaceId: string): Promise<void> {
  const path = await import("node:path");
  const { rm } = await import("node:fs/promises");
  const { PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
  await rm(path.join(root, ".llmwiki", "workspaces", workspaceId, PREPARATIONS_SEGMENT),
    { recursive: true, force: true });
}

/** Plant `count` unreadable manifest leaves, as anything with write access could. */
async function plantJunkManifests(
  root: string, workspaceId: string, count: number,
): Promise<void> {
  const path = await import("node:path");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { MANIFEST_FILENAME, PREPARATIONS_SEGMENT } = await import("../src/preparations/paths.js");
  const base = path.join(root, ".llmwiki", "workspaces", workspaceId, PREPARATIONS_SEGMENT);
  for (let index = 0; index < count; index += 1) {
    // The id grammar has to pass the scanner's own leaf validation, or the leaf
    // is ignored rather than reported and the fixture proves nothing.
    const directory = path.join(base, `prep_${String(index).padStart(6, "0")}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, MANIFEST_FILENAME), "{ corrupt");
  }
}

let atCap = "";
let overCap = "";

beforeAll(async () => {
  atCap = await emptyWorkspace("boundatcap");
  await stageMany(atCap, MAX_PREPARATION_LIST_ITEMS);
  // COPIED rather than rebuilt: the over-cap store is the at-cap store plus
  // five, and rebuilding it from zero would double the fixture cost for no
  // additional coverage.
  const { cp } = await import("node:fs/promises");
  overCap = await emptyWorkspace("boundovercap");
  await cp(atCap, overCap, { recursive: true });
  await stageMany(overCap, 5, MAX_PREPARATION_LIST_ITEMS);
}, 300_000);

describe("the list response is bounded, and says so", () => {
  it("reports an exact total and no truncation below the cap", async () => {
    const cwd = await emptyWorkspace("boundunder");
    await stageMany(cwd, 3);
    const listing = await reader(cwd).list();
    expect(listing.runs).toHaveLength(3);
    expect(listing.total).toBe(3);
    expect(listing.truncated).toBe(false);
  }, 60_000);

  it("does not truncate at EXACTLY the cap", async () => {
    // The boundary itself: an off-by-one here reports a complete answer as
    // truncated, or the reverse.
    const listing = await reader(atCap).list();
    expect(listing.runs).toHaveLength(MAX_PREPARATION_LIST_ITEMS);
    expect(listing.total).toBe(MAX_PREPARATION_LIST_ITEMS);
    expect(listing.truncated).toBe(false);
  });

  it("caps above it, keeping the TRUE total and flagging truncation", async () => {
    const listing = await reader(overCap).list();
    expect(listing.runs).toHaveLength(MAX_PREPARATION_LIST_ITEMS);
    expect(listing.total).toBe(MAX_PREPARATION_LIST_ITEMS + 5);
    expect(listing.truncated).toBe(true);
  });

  it("does NOT report a run-accounting problem merely because it capped", async () => {
    // The trap in this file's header, and the reason the cross-check runs over
    // the full row set rather than the capped one.
    const listing = await reader(overCap).list();
    expect(listing.truncated).toBe(true);
    expect(listing.problems.join(" ")).not.toMatch(/run-accounting/u);
  });

  it("truncates DETERMINISTICALLY — the same hundred on every call", async () => {
    // A cap over an unstable order is worse than no cap: it answers with a
    // different hundred each time and nothing reports the difference.
    const first = await reader(overCap).list();
    const second = await reader(overCap).list();
    expect(second.runs.map((row) => row.runId)).toEqual(first.runs.map((row) => row.runId));
    expect(new Set(first.runs.map((row) => row.runId)).size).toBe(MAX_PREPARATION_LIST_ITEMS);
  });

  it("truncates in the SPECIFIED order, not merely a stable one", async () => {
    // THE GAP THE TEST ABOVE LEFT. Replacing the comparator with `.reverse()`
    // kept that test green — any fixed order is stable across two calls, so
    // "deterministic" was satisfied by an order that is not the specified one,
    // and the hundred runs kept would have been the WRONG hundred. §6 wants a
    // deterministic cap; D-10-5 says which order that is.
    //
    // Asserted as a PROPERTY over what came back, against creation times read
    // from the same durable manifests — newest first, ties ascending by typed
    // id — rather than by re-running the projection and comparing it to itself.
    const createdAt = await manifestCreationTimes(overCap);
    const listing = await reader(overCap).list();
    const rows = listing.runs.map((row) => ({
      runId: row.runId, createdAt: createdAt.get(row.runId) as string,
    }));
    expect(rows.every((row) => typeof row.createdAt === "string")).toBe(true);
    const misordered = rows.filter((row, index) =>
      index > 0 && comparePreparationListing(rows[index - 1] as typeof row, row) > 0);
    expect(misordered).toEqual([]);
    // And the cap kept the NEWEST hundred: nothing omitted outranks what stayed.
    const kept = new Set(rows.map((row) => row.runId));
    const dropped = [...createdAt].filter(([runId]) => !kept.has(runId));
    const oldestKept = rows[rows.length - 1] as { runId: string; createdAt: string };
    for (const [runId, at] of dropped) {
      expect(comparePreparationListing({ runId, createdAt: at }, oldestKept)).toBeGreaterThan(0);
    }
  });
});

describe("the cap cannot evict the run-accounting signal", () => {
  it("still reports run-accounting under a HUNDRED planted problems", async () => {
    // THE REGRESSION THE CAP ITSELF INTRODUCED. Manifest leaves are
    // filesystem-plantable and the scan emits one `manifest-state` problem per
    // unreadable leaf, so a hundred junk manifests filled the response and
    // evicted the accounting line that was appended after them. The answer
    // became `runs: [], total: 0, truncated: false` with run bytes on disk —
    // the silently-empty answer this operation's cross-check exists to prevent,
    // reintroduced by the bound that was supposed to make it honest.
    const cwd = await emptyWorkspace("boundevict");
    const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
    const { binding } = await stagePreparation(cwd);
    await deletePreparationDirectory(cwd, binding.workspaceId);
    await plantJunkManifests(cwd, binding.workspaceId, MAX_PREPARATION_LIST_ITEMS);

    const listing = await reader(cwd).list();

    // The planted family really did overflow the cap...
    expect(listing.problemsTruncated).toBe(true);
    expect(listing.problemTotal).toBeGreaterThan(MAX_PREPARATION_LIST_ITEMS);
    // ...and the signal survived it anyway.
    expect(listing.problems.join(" ")).toMatch(/run-accounting/u);
  }, 120_000);
});

describe("the listing comparator has one home and one order", () => {
  it("orders creation time DESCENDING, then run id ascending", () => {
    const older = { createdAt: "2026-08-01T00:00:00.000Z", runId: "prr_b" };
    const newer = { createdAt: "2026-08-02T00:00:00.000Z", runId: "prr_a" };
    expect(comparePreparationListing(newer, older)).toBeLessThan(0);
    expect(comparePreparationListing(older, newer)).toBeGreaterThan(0);
  });

  it("breaks a creation-time tie on the typed id, so the cap is reproducible", () => {
    const at = "2026-08-01T00:00:00.000Z";
    expect(comparePreparationListing({ createdAt: at, runId: "prr_a" }, { createdAt: at, runId: "prr_b" }))
      .toBeLessThan(0);
    expect(comparePreparationListing({ createdAt: at, runId: "prr_a" }, { createdAt: at, runId: "prr_a" }))
      .toBe(0);
  });
});

describe("problems carry their own bound", () => {
  it("counts and flags problems separately from runs", async () => {
    // §6 gives problems their own total and truncation signal rather than
    // folding them into the run counters — a different family with a different
    // growth path. The exact key set is pinned so a later field cannot be added
    // to the response without a decision.
    const cwd = await emptyWorkspace("boundproblemshape");
    const listing: ListResultV1 = await reader(cwd).list();
    expect(Object.keys(listing).sort()).toEqual([
      "problemTotal", "problems", "problemsTruncated", "runs", "total", "truncated",
    ]);
    expect(listing.problemTotal).toBe(listing.problems.length);
    expect(listing.problemsTruncated).toBe(false);
  });
});
