/**
 * @file test/portable/h1-completion-validation.test.ts
 * @description H1: what completing an interrupted commit's labels refuses to
 * do, and when it runs.
 *
 * A newer binding of different bytes — the path's current bytes — keeps its
 * digest and its stricter labels. A malformed later target, a receipt that is
 * not the one its intent recorded, and a receipt carried in from another
 * project all refuse `recovery_blocking` BEFORE the first label is written or
 * the intent removed. Completion is host-owned: a caller revoked while it
 * queued is answered `not_found` and triggers no recovery of its own, but the
 * already-committed operation's labels are still finished.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { bytesDigest } from "../../src/portable/digest.js";
import { ledgerPath } from "./disk-format-helpers.js";
import { h1World, intentPresent, labelRecord, newSource, publish, readSource, sourceFile, storeOf, type H1World } from "./h1-helpers.js";
import { revokeWhileQueued } from "./helpers.js";

let world: H1World;
beforeEach(async () => { world = await h1World(); });
afterEach(async () => { vi.restoreAllMocks(); await world.fixture.cleanup(); });

/** Publish two restricted sources as `op`, crashing right after the receipt. */
async function crashedPair(): Promise<void> {
  const writes = [newSource(world, "a.md", "# A\n"), newSource(world, "b.md", "# B\n")];
  await expect(publish(world, await storeOf(world, "after-receipt"), "op", writes)).rejects.toThrow("simulated crash");
}

/** Rewrite one ledger record of `op` through `change`. */
async function editRecord(kind: "intents" | "receipts", change: (record: Record<string, any>) => void): Promise<void> {
  const file = ledgerPath(world.fixture, kind, "op.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  change(record);
  await writeFile(file, JSON.stringify(record));
}

describe("bindings made since the commit", () => {
  it("keeps a newer different-byte binding of the current bytes, raised to the committed labels", async () => {
    await crashedPair();
    const newer = Buffer.from("# A, edited and classified\n");
    await writeFile(sourceFile(world, "a.md"), newer);
    await (await storeOf(world)).reconcileLabels("sources/a.md", bytesDigest(newer), [...world.restricted, "newer-restriction"]);
    expect(await readSource(world.session, "a.md")).toEqual({ visible: false });
    const bound = await labelRecord(world, "sources/a.md");
    expect([bound?.digest, [...(bound?.labels ?? [])].sort()]).toEqual([bytesDigest(newer), [...world.restricted, "newer-restriction"].sort()]);
    expect(await readFile(sourceFile(world, "a.md"))).toEqual(newer);
  });
});

describe("records that cannot be trusted refuse before any effect", () => {
  it("refuses a malformed later target without binding the first one or removing the intent", async () => {
    await crashedPair();
    await editRecord("intents", (intent) => { intent.targets[1].labels = ["restricted", 7]; });
    expect(await readSource(world.session, "a.md")).toEqual({ refused: "recovery_blocking" });
    expect(await labelRecord(world, "sources/a.md")).toBeNull();
    expect(await intentPresent(world, "op")).toBe(true);
    expect((await world.session.project.status("op")).kind).toBe("committed");
  });

  it("refuses a receipt that is not the one its intent recorded", async () => {
    await crashedPair();
    await editRecord("receipts", (receipt) => { receipt.intentDigest = bytesDigest(Buffer.from("another intent")); });
    expect(await readSource(world.session, "a.md")).toEqual({ refused: "recovery_blocking" });
    expect(await labelRecord(world, "sources/a.md")).toBeNull();
    expect(await intentPresent(world, "op")).toBe(true);
  });

  it("never honours a receipt carried in from another project", async () => {
    await crashedPair();
    await editRecord("receipts", (receipt) => { receipt.project = "prj_000000000000000000000000"; });
    expect(await readSource(world.session, "a.md")).toEqual({ refused: "recovery_blocking" });
    expect(await labelRecord(world, "sources/a.md")).toBeNull();
  });
});

describe("completion is host-owned", () => {
  it("finishes a committed operation's labels for a caller revoked while it queued, which triggers nothing else", async () => {
    await crashedPair();
    revokeWhileQueued(world.fixture.controlRoot, world.fixture.projectId);
    expect(await world.session.project.status("op")).toEqual({ kind: "not_found" });
    expect((await labelRecord(world, "sources/a.md"))?.labels).toEqual(world.restricted);
    expect(await intentPresent(world, "op")).toBe(false);
    const identity = JSON.parse(await readFile(ledgerPath(world.fixture, "identity", "op.json"), "utf8"));
    expect(identity.outcome).toBe("in-progress");
  });
});
