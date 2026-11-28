/**
 * @file test/portable/h1-completion-block.test.ts
 * @description H1: while a committed publication's labels cannot be completed
 * with certainty, the ordinary gate refuses `recovery_blocking` for every step —
 * a new source, a proposal, a resolve, a read — before any effect: no identity
 * record, no file, no model work. Only an authorized status read still
 * answers, from the receipt, and it runs no recovery. Restoring the damaged
 * record lets the next step complete the labels and proceed. Also: targets
 * that are not exactly the receipt's published objects, and an own-project
 * receipt beside an intent naming another project, removed targets, or an
 * intent file holding only `null`, refuse before any effect.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ledgerPath } from "./disk-format-helpers.js";
import { h1World, intentPresent, labelRecord, newSource, plantLabelRecord, publish, readSource, sourceFile, storeOf, type H1World } from "./h1-helpers.js";
import { prepared } from "./helpers.js";

let world: H1World;
beforeEach(async () => { world = await h1World(); });
afterEach(async () => { await world.fixture.cleanup(); });

/** Publish one restricted source as `op`, crashing right after the receipt. */
async function crashedSource(): Promise<void> {
  await expect(publish(world, await storeOf(world, "after-receipt"), "op", [newSource(world, "restricted.md", "# R\n")])).rejects.toThrow("simulated crash");
}

/** A public call's settled answer: its outcome kind, or the code it was refused with. */
async function attempt(call: () => Promise<{ kind: string; code?: string }>): Promise<string> {
  const answer = await call().catch((error: { code?: string }) => ({ kind: "thrown", code: error.code }));
  return answer.kind === "refused" || answer.kind === "thrown" ? `refused:${answer.code}` : answer.kind;
}

/** The identity records on disk. */
async function identities(): Promise<string[]> {
  return (await readdir(ledgerPath(world.fixture, "identity", ""))).sort();
}

describe("a completion block", () => {
  it("refuses a new source, a proposal and a resolve before any effect, while status reports the commit", async () => {
    const operationId = await world.session.project.allocateOperation();
    await crashedSource();
    await plantLabelRecord(world, "sources/restricted.md", "{ damaged");
    const before = await identities();
    const { project } = world.session;
    expect(await attempt(() => project.sources.add({ operationId, name: "new.md", upload: prepared("# New\n") }))).toBe("refused:recovery_blocking");
    expect(await attempt(() => project.propose({ operationId }))).toBe("refused:recovery_blocking");
    expect(await attempt(() => project.resolve({ operationId: "op", decision: "retry-recovery", reason: "try" }))).toBe("refused:recovery_blocking");
    expect(await identities()).toEqual(before);
    await expect(readFile(sourceFile(world, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await project.status("op")).kind).toBe("committed");
    await plantLabelRecord(world, "sources/restricted.md", JSON.stringify({ path: "sources/restricted.md", digest: "sha256:0", labels: [], by: "restored" }));
    expect(await attempt(() => project.sources.add({ operationId, name: "new.md", upload: prepared("# New\n") }))).toBe("committed");
    expect((await labelRecord(world, "sources/restricted.md"))?.labels).toEqual(world.restricted);
  });
});

describe("an intent that does not match its own project's receipt", () => {
  /** Rewrite the intent of `op` through `change` (whose answer, when given, replaces it), then require the next read to refuse with nothing bound. */
  async function refusesAfter(change: (intent: Record<string, any>) => unknown): Promise<void> {
    await crashedSource();
    const file = ledgerPath(world.fixture, "intents", "op.json");
    const intent = JSON.parse(await readFile(file, "utf8"));
    const replaced = change(intent);
    await writeFile(file, JSON.stringify(replaced === undefined ? intent : replaced));
    expect(await readSource(world.session, "restricted.md")).toEqual({ refused: "recovery_blocking" });
    expect(await labelRecord(world, "sources/restricted.md")).toBeNull();
    expect(await intentPresent(world, "op")).toBe(true);
  }

  it("refuses targets with weaker labels than the receipt published", async () => {
    await refusesAfter((intent) => { intent.targets[0].labels = [world.compartment]; });
  });

  it("refuses an intent naming another project beside this project's receipt", async () => {
    await refusesAfter((intent) => { intent.project = "prj_000000000000000000000000"; });
  });

  it("refuses an intent with its targets removed", async () => {
    await refusesAfter((intent) => { intent.targets = []; });
  });

  it("refuses an intent file holding nothing but null", async () => {
    await refusesAfter(() => null);
  });
});
