/**
 * @file test/portable/settled-replay.test.ts
 * @description A settled local publication cannot be published again, at
 * either layer. Through the public project API, a second submission under a
 * committed operation id answers from the record (the same outcome, no second
 * write) and one with different content is rejected. At the store itself,
 * which the authority never reaches for a known id, an operation that already
 * has a receipt or a close is refused before any pre-image, intent or target
 * is written. The product's own commit body (`commitReceipt`), run on the
 * ledger a real interrupted publication left, refuses a receipt that is not
 * the intent's before any label is bound or the intent removed, and accepts
 * the exact receipt of a resumed commit. Local disk only; no model, host or
 * network.
 */

import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { readDiskIntent } from "../../src/portable/store/disk-intent.js";
import { commitReceipt } from "../../src/portable/store/disk-publish.js";
import type { DiskStoreContext } from "../../src/portable/store/disk-store.js";
import { ledgerPath } from "./disk-format-helpers.js";
import { freshWorldPerTest, intentPresent, labelRecord, newSource, publish, sourceFile, storeOf, type H1World } from "./h1-helpers.js";
import { prepared } from "./helpers.js";

let world: H1World;
freshWorldPerTest((made) => { world = made; });

/** The names in one ledger directory (none when it is absent). */
const ledgerNames = (kind: string): Promise<string[]> => readdir(ledgerPath(world.fixture, kind, "")).catch(() => []);

describe("a settled operation is answered from its record", () => {
  it("returns the committed outcome again without writing the source a second time", async () => {
    const { project } = world.session;
    const operationId = await project.allocateOperation();
    const request = { operationId, name: "note.md", upload: prepared("# Note\n") };
    const first = await project.sources.add(request);
    expect(first.kind).toBe("committed");
    const written = await stat(sourceFile(world, "note.md"));
    const replay = await project.sources.add(request);
    expect(replay).toEqual(first);
    expect((await stat(sourceFile(world, "note.md"))).mtimeMs).toBe(written.mtimeMs);
    expect(await ledgerNames("intents")).toEqual([]);
  });

  it("rejects a different request under the same operation id and changes nothing", async () => {
    const { project } = world.session;
    const operationId = await project.allocateOperation();
    await project.sources.add({ operationId, name: "note.md", upload: prepared("# Note\n") });
    const other = await project.sources.add({ operationId, name: "note.md", upload: prepared("# Other\n") });
    expect(other).toMatchObject({ kind: "rejected", reason: "operation_id_in_use" });
    expect(await readFile(sourceFile(world, "note.md"), "utf8")).toBe("# Note\n");
  });
});

describe("the store refuses to publish a settled operation", () => {
  it("refuses an operation that already has a receipt, before any pre-image, intent or target", async () => {
    await publish(world, await storeOf(world), "op", [newSource(world, "a.md", "# A\n")]);
    const preimages = await ledgerNames("preimages");
    await expect(publish(world, await storeOf(world), "op", [newSource(world, "b.md", "# B\n")])).rejects.toMatchObject({ code: "recovery_blocking" });
    expect(await readFile(sourceFile(world, "b.md"), "utf8").catch(() => null)).toBeNull();
    expect(await intentPresent(world, "op")).toBe(false);
    expect(await ledgerNames("preimages")).toEqual(preimages);
  });
});

/** The commit body's context for the current world's ledger, with the store's own bounds. */
async function commitContext(): Promise<DiskStoreContext> {
  const megabyte = 1024 * 1024;
  return { root: await realpath(world.fixture.root), projectId: world.fixture.projectId, maxObjectBytes: megabyte, maxPreimageBytes: 8 * megabyte, maxRecordBytes: 16 * megabyte };
}

/** Interrupt a real publication of one restricted source at `stage`; returns the intent it left on disk. */
async function interruptedAt(stage: "after-writes" | "after-receipt") {
  await expect(publish(world, await storeOf(world, stage), "op", [newSource(world, "a.md", "# A\n")])).rejects.toThrow("simulated crash");
  const intent = await readDiskIntent(world.fixture.root, "op");
  expect(intent).not.toBeNull();
  return intent!;
}

describe("the commit body vouches only for its own receipt", () => {
  const receiptFile = (): string => ledgerPath(world.fixture, "receipts", "op.json");

  it("refuses a different receipt recorded under the id, and settles nothing", async () => {
    const intent = await interruptedAt("after-writes");
    const foreign = JSON.stringify({ ...intent.receipt, published: [], committedAt: "2000-01-01T00:00:00.000Z" });
    // The "after-writes" crash lands before the commit's receipt write, which is what creates the receipts
    // directory, so a fresh ledger has none yet; create it to plant the foreign receipt.
    await mkdir(path.dirname(receiptFile()), { recursive: true });
    await writeFile(receiptFile(), foreign);
    await expect(commitReceipt(await commitContext(), intent)).rejects.toMatchObject({ code: "recovery_blocking" });
    expect(await readFile(receiptFile(), "utf8")).toBe(foreign);
    expect(await intentPresent(world, "op")).toBe(true);
    expect(await labelRecord(world, "sources/a.md")).toBeNull();
    expect(await readFile(sourceFile(world, "a.md"), "utf8")).toBe("# A\n");
  });

  it("accepts the exact receipt of a commit interrupted after it, then binds the labels and removes the intent", async () => {
    const intent = await interruptedAt("after-receipt");
    const recorded = await readFile(receiptFile(), "utf8");
    expect(recorded).toBe(JSON.stringify(intent.receipt));
    expect(await labelRecord(world, "sources/a.md")).toBeNull();
    await commitReceipt(await commitContext(), intent);
    expect(await readFile(receiptFile(), "utf8")).toBe(recorded);
    expect(await labelRecord(world, "sources/a.md")).toMatchObject({ labels: world.restricted, by: "op" });
    expect(await intentPresent(world, "op")).toBe(false);
  });
});
