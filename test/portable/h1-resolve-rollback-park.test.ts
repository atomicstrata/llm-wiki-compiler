/**
 * @file test/portable/h1-resolve-rollback-park.test.ts
 * @description H1-R: a rollback of a parked intent acts only on the target set
 * its OWN whole-set observation still recognises (spec §8.4 step 7, §8.7).
 *
 * A three-target publication (replace kept.md, replace other.md, create
 * added.md) is interrupted after two writes: two targets at their post-image,
 * one still absent. Something then changes the targets in the window after the
 * resolver's final observation, or after automatic recovery's decision, and
 * before the rollback observes them itself. If any target is now at neither
 * image, the rollback parks BEFORE its first write: external bytes and the
 * operation's other post-images survive, the operator gets the existing
 * `targets_changed`, and no close, identity transition or success audit is
 * recorded. An unchanged set still rolls back, and a retained pre-image damaged
 * in that window is still `preimage_unavailable`, not a changed target.
 *
 * The rollback also refuses a change to a KNOWN image: a two-target
 * publication (replace kept.md, create added.md) interrupted after one write,
 * whose absent added.md is then created externally with bytes identical to its
 * planned post-image. The rollback's own observation sees a post-image there,
 * but the set it was asked to roll back had it absent: it must not unlink the
 * external file, revert kept.md or close.
 *
 * This narrows the window; it does not close it. A hand edit after the
 * rollback's own observation, between its per-target writes, is not seen.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it, spyOn } from "bun:test";
import { LocalHostControl } from "../../src/portable/host/local-control.js";
import { DiskProjectStore } from "../../src/portable/store/disk-store.js";
import { ledgerPath } from "./disk-format-helpers.js";
import {
  freshWorldPerTest, intentPresent, newSource, preimageFile, publish, replaceSource, sourceFile, storeOf, type H1World, type H1Write,
} from "./h1-helpers.js";

let world: H1World;
freshWorldPerTest((fresh) => { world = fresh; });

const KEPT_OLD = Buffer.from("# Kept old\n");
const OTHER_OLD = Buffer.from("# Other old\n");
const OTHER_NEW = "# Other new\n";

/** Seed kept.md and other.md, then crash `op` [replace kept, replace other, create added] after two writes. */
async function crashedTriple(): Promise<void> {
  await publish(world, await storeOf(world), "seed", [newSource(world, "kept.md", KEPT_OLD.toString()), newSource(world, "other.md", OTHER_OLD.toString())]);
  const writes: H1Write[] = [
    replaceSource("kept.md", KEPT_OLD, world.restricted, "# Kept new\n", world.restricted),
    replaceSource("other.md", OTHER_OLD, world.restricted, OTHER_NEW, world.restricted), newSource(world, "added.md", "# Added\n"),
  ];
  await expect(publish(world, await storeOf(world, "after-target", 2), "op", writes)).rejects.toThrow("simulated crash after-target");
}

/** The three targets' bytes now (`null` when absent). */
async function targets(): Promise<(string | null)[]> {
  return Promise.all(["kept.md", "other.md", "added.md"].map((name) => readFile(sourceFile(world, name), "utf8").catch(() => null)));
}

/** Whether `op` has a durable close record, and the bytes of `op`'s own identity record. */
async function durableState(): Promise<{ closed: boolean; identity: string[] }> {
  const dir = ledgerPath(world.fixture, "identity", "");
  const all = await Promise.all((await readdir(dir)).sort().map((name) => readFile(`${dir}/${name}`, "utf8")));
  const closed = await readFile(ledgerPath(world.fixture, "closed", "op.json")).then(() => true, () => false);
  return { closed, identity: all.filter((text) => JSON.parse(text).operationId === "op") };
}

/** Operator `roll-back-own-writes` on `op`, running `between` once right after the resolver's FINAL (second) observation. */
async function rollBackWithChange(between: () => Promise<void>): Promise<{ outcome: unknown; audits: unknown[] }> {
  const observe = DiskProjectStore.prototype.observeIntent;
  let calls = 0;
  const observed = spyOn(DiskProjectStore.prototype, "observeIntent").mockImplementation(async function (this: DiskProjectStore, operationId: string) {
    const seen = await observe.call(this, operationId);
    if (++calls === 2) await between();
    return seen;
  });
  const audit = spyOn(LocalHostControl.prototype, "audit");
  try {
    const outcome = await world.session.project.resolve({ operationId: "op", decision: "roll-back-own-writes", reason: "operator rollback" })
      .catch((error: { code?: string }) => ({ thrown: error.code }));
    expect(calls).toBe(2);
    // LocalHostControl.audit() declares no parameter, but every caller passes the event as its first argument.
    return { outcome, audits: audit.mock.calls.map((call) => (call as unknown[])[0]) };
  } finally {
    observed.mockRestore();
    audit.mockRestore();
  }
}

/** Automatic recovery of `op` through a store whose rollback seam runs `atSeam` (synchronously, once). */
async function recoverWithSeam(atSeam: () => void): Promise<{ results: unknown; fired: number }> {
  let fired = 0;
  const store = await DiskProjectStore.open(world.fixture.projectId, world.fixture.root, {
    registration: async () => "format-2",
    faultForTest: (stage) => { if (stage === "before-rollback-observation") { fired += 1; atSeam(); } },
  });
  return { results: await store.withGate(() => store.recover()), fired };
}

const ADDED_PLANNED = "# Added\n";

/** Seed kept.md, then crash `op` [replace kept, create added] after ONE write: kept at post-image, added absent. */
async function crashedPair(): Promise<void> {
  await publish(world, await storeOf(world), "seed", [newSource(world, "kept.md", KEPT_OLD.toString())]);
  const writes: H1Write[] = [replaceSource("kept.md", KEPT_OLD, world.restricted, "# Kept new\n", world.restricted), newSource(world, "added.md", ADDED_PLANNED)];
  await expect(publish(world, await storeOf(world, "after-target", 1), "op", writes)).rejects.toThrow("simulated crash after-target");
}

/** Every regular file under the project root with its sha256, to prove a step wrote nothing. */
async function projectSnapshot(dir = world.fixture.root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await projectSnapshot(full));
    else if (entry.isFile()) files[path.relative(world.fixture.root, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
  }
  return files;
}

/** `files` plus exactly the external added.md: what the project must hold if the step itself wrote nothing. */
function withExternalAdded(files: Record<string, string>): Record<string, string> {
  return { ...files, [path.join("sources", "added.md")]: createHash("sha256").update(ADDED_PLANNED).digest("hex") };
}

/** Create added.md externally with bytes identical to its planned post-image (absent → a known post-image). */
function externalPlannedAdded(): void {
  writeFileSync(sourceFile(world, "added.md"), ADDED_PLANNED);
}

describe("operator rollback when a target changes after the resolver's final observation", () => {
  it("parks before any write, keeps both external bytes and the other post-image, and records nothing", async () => {
    // No status call first: its automatic recovery would roll the unchanged set back before the operator acts.
    await crashedTriple();
    const before = await durableState();
    const { outcome, audits } = await rollBackWithChange(async () => {
      await writeFile(sourceFile(world, "kept.md"), "hand edit A\n");
      await writeFile(sourceFile(world, "added.md"), "external file B\n");
    });
    expect(outcome).toEqual({ kind: "refused", code: "targets_changed" });
    expect(await targets()).toEqual(["hand edit A\n", OTHER_NEW, "external file B\n"]);
    expect(audits.filter((event) => (event as { kind?: string }).kind === "operation-resolved")).toEqual([]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
    expect(await world.session.project.status("op")).toEqual({ kind: "unknown", operationId: "op" });
  });
});

describe("automatic recovery when the target set changes at the rollback seam", () => {
  it("parks before any write, keeping the external bytes and the other post-image", async () => {
    await crashedTriple();
    const before = await durableState();
    const { results, fired } = await recoverWithSeam(() => writeFileSync(sourceFile(world, "kept.md"), "hand edit C\n"));
    expect(fired).toBe(1);
    expect(results).toEqual([{ operationId: "op", result: "parked" }]);
    expect(await targets()).toEqual(["hand edit C\n", OTHER_NEW, null]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });

  it("still rolls back its own writes when nothing changes at the seam", async () => {
    await crashedTriple();
    const { results, fired } = await recoverWithSeam(() => undefined);
    expect(fired).toBe(1);
    expect(results).toEqual([{ operationId: "op", result: "no-effect", detail: "rolled_back" }]);
    expect(await targets()).toEqual([KEPT_OLD.toString(), OTHER_OLD.toString(), null]);
    expect((await durableState()).closed).toBe(true);
  });
});

describe("operator rollback when a retained pre-image is damaged after the final observation", () => {
  it("still refuses preimage_unavailable, not targets_changed, and writes or records nothing", async () => {
    // No status call first: its automatic recovery would roll the unchanged set back before the operator acts.
    await crashedTriple();
    const before = await durableState();
    const { outcome } = await rollBackWithChange(() => writeFile(preimageFile(world, OTHER_OLD), "corrupted\n"));
    expect(outcome).toEqual({ thrown: "preimage_unavailable" });
    expect(await targets()).toEqual(["# Kept new\n", OTHER_NEW, null]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });
});

describe("a target moving from absent to its known planned post-image after the decision", () => {
  it("operator rollback refuses targets_changed and writes, closes and audits nothing", async () => {
    await crashedPair();
    const [before, files] = [await durableState(), await projectSnapshot()];
    const { outcome, audits } = await rollBackWithChange(async () => externalPlannedAdded());
    expect(outcome).toEqual({ kind: "refused", code: "targets_changed" });
    expect(await projectSnapshot()).toEqual(withExternalAdded(files));
    expect(await targets()).toEqual(["# Kept new\n", null, ADDED_PLANNED]);
    expect(audits.filter((event) => (event as { kind?: string }).kind === "operation-resolved")).toEqual([]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });

  it("automatic recovery parks when the change lands at the rollback seam, writing nothing", async () => {
    await crashedPair();
    const [before, files] = [await durableState(), await projectSnapshot()];
    const { results, fired } = await recoverWithSeam(externalPlannedAdded);
    expect(fired).toBe(1);
    expect(results).toEqual([{ operationId: "op", result: "parked" }]);
    expect(await projectSnapshot()).toEqual(withExternalAdded(files));
    expect(await targets()).toEqual(["# Kept new\n", null, ADDED_PLANNED]);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await durableState()).toEqual(before);
  });
});
