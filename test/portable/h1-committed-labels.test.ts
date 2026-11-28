/**
 * @file test/portable/h1-committed-labels.test.ts
 * @description H1: a publication that committed but crashed before all of its
 * label bindings were written. The receipt is authoritative, so the outcome is
 * committed throughout; the next gated step — any read, in an already-open or a
 * reopened session, with no status call first — finishes the bindings before
 * it serves anything, and never lowers a binding of the same bytes.
 *
 * Covered: a crash after the receipt and after the labels; a different-byte
 * external edit; a stricter same-byte relabel; the same-byte pre/post case with
 * stricter intended labels; a weaker binding a reader reconciled meanwhile; a
 * damaged label record, which refuses content access until it is restored
 * while an authorized status still reports the commit; and repeated recovery.
 * Process-crash snapshots, not power-loss tests.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { bytesDigest } from "../../src/portable/digest.js";
import {
  freshWorldPerTest, intentPresent, labelRecord, newSource, plantLabelRecord, publish, readSource, replaceSource, sourceFile, storeOf, type H1World,
} from "./h1-helpers.js";

let world: H1World;
freshWorldPerTest((fresh) => { world = fresh; });

const TEXT = "# Restricted source\n";

/** Publish one restricted source as `operationId`, crashing at `stage`. */
async function crashedSource(operationId: string, stage: "after-receipt" | "after-labels"): Promise<void> {
  const crashing = await storeOf(world, stage);
  await expect(publish(world, crashing, operationId, [newSource(world, "restricted.md", TEXT)])).rejects.toThrow("simulated crash");
}

describe("a commit interrupted after its receipt", () => {
  it("withholds the read in the open and a reopened session, completes the labels, and stays committed", async () => {
    await crashedSource("op-receipt", "after-receipt");
    expect(await readSource(world.session, "restricted.md")).toEqual({ visible: false });
    const reopened = await world.fixture.open();
    expect(await readSource(reopened, "restricted.md")).toEqual({ visible: false });
    expect(await labelRecord(world, "sources/restricted.md")).toMatchObject({ digest: bytesDigest(Buffer.from(TEXT)), labels: world.restricted, by: "op-receipt" });
    expect(await intentPresent(world, "op-receipt")).toBe(false);
    expect((await reopened.project.status("op-receipt")).kind).toBe("committed");
    expect(await readFile(sourceFile(world, "restricted.md"), "utf8")).toBe(TEXT);
  });

  it("only removes the intent when the labels were already bound, and repeated recovery changes nothing", async () => {
    await crashedSource("op-labels", "after-labels");
    const bound = await labelRecord(world, "sources/restricted.md");
    expect((await world.session.project.status("op-labels")).kind).toBe("committed");
    expect(await intentPresent(world, "op-labels")).toBe(false);
    expect((await world.session.project.status("op-labels")).kind).toBe("committed");
    expect(await labelRecord(world, "sources/restricted.md")).toEqual(bound);
  });
});

describe("what changed after the commit is never lowered or rewritten", () => {
  it("keeps a different-byte external edit as it is, and reads it no lower than the committed labels", async () => {
    await crashedSource("op-edit", "after-receipt");
    await writeFile(sourceFile(world, "restricted.md"), "edited outside the portable path\n");
    expect(await readSource(world.session, "restricted.md")).toEqual({ visible: false });
    expect(await readFile(sourceFile(world, "restricted.md"), "utf8")).toBe("edited outside the portable path\n");
    expect((await labelRecord(world, "sources/restricted.md"))?.labels).toContain("restricted");
    expect((await world.session.project.status("op-edit")).kind).toBe("committed");
  });

  it("keeps a stricter same-byte binding made meanwhile", async () => {
    await crashedSource("op-same", "after-receipt");
    const digest = bytesDigest(Buffer.from(TEXT));
    await plantLabelRecord(world, "sources/restricted.md", JSON.stringify({ path: "sources/restricted.md", digest, labels: [...world.restricted, "stricter"], by: "newer" }));
    await readSource(world.session, "restricted.md");
    expect((await labelRecord(world, "sources/restricted.md"))?.labels).toEqual([...world.restricted, "stricter"].sort());
  });

  it("raises a weaker binding a reader reconciled while the labels were missing", async () => {
    await crashedSource("op-weak", "after-receipt");
    const digest = bytesDigest(Buffer.from(TEXT));
    await plantLabelRecord(world, "sources/restricted.md", JSON.stringify({ path: "sources/restricted.md", digest, labels: [world.compartment], by: "reconciled" }));
    await readSource(world.session, "restricted.md");
    expect((await labelRecord(world, "sources/restricted.md"))?.labels).toEqual([...world.restricted].sort());
  });

  it("binds the stricter labels when the pre- and post-image are the same bytes", async () => {
    await publish(world, await storeOf(world), "op-first", [newSource(world, "same.md", TEXT, [world.compartment])]);
    const crashing = await storeOf(world, "after-receipt");
    const write = replaceSource("same.md", Buffer.from(TEXT), [world.compartment], TEXT, world.restricted);
    await expect(publish(world, crashing, "op-stricter", [write])).rejects.toThrow("simulated crash");
    expect(await readSource(world.session, "same.md")).toEqual({ visible: false });
    expect((await labelRecord(world, "sources/same.md"))?.labels).toEqual([...world.restricted].sort());
  });
});

describe("a label record that cannot be read with certainty", () => {
  it("refuses content access until it is restored, while an authorized status still reports the commit", async () => {
    await crashedSource("op-damaged", "after-receipt");
    await plantLabelRecord(world, "sources/restricted.md", "{ not json");
    expect(await readSource(world.session, "restricted.md")).toEqual({ refused: "recovery_blocking" });
    expect((await world.session.project.status("op-damaged")).kind).toBe("committed");
    expect(await readSource(world.session, "restricted.md")).toEqual({ refused: "recovery_blocking" });
    expect(await readFile(sourceFile(world, "restricted.md"), "utf8")).toBe(TEXT);
    expect(await intentPresent(world, "op-damaged")).toBe(true);
    await plantLabelRecord(world, "sources/restricted.md", JSON.stringify({ path: "sources/restricted.md", digest: "sha256:0", labels: [], by: "restored" }));
    expect((await world.session.project.status("op-damaged")).kind).toBe("committed");
    expect((await labelRecord(world, "sources/restricted.md"))?.labels).toEqual(world.restricted);
  });
});
