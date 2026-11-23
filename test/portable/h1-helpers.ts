/**
 * @file test/portable/h1-helpers.ts
 * @description A registered, format-2 project for the H1 crash witnesses, and a
 * direct-store publication that can be interrupted at any internal protocol
 * stage — after a given NUMBER of target writes included.
 *
 * Restricted labels are bound directly through the store, as a scoped
 * publication would bind them: the public `sources.add` only ever binds the
 * project compartment, which would hide a weakened label. These are process
 * crash snapshots made by the real publish code; they are not power-loss tests.
 *
 * The witnesses share one two-target pair (`PAIR`, `seedKept`, `pairWrites`,
 * `publishCrashing`), the reads they assert on (`sourceText`, `closeRecorded`),
 * and one hook that changes a target right after the resolver's first
 * observation (`afterFirstObservation`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, spyOn } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import path from "node:path";
import type { ObjectImage, ReceiptV1 } from "../../src/portable/contracts.js";
import { bytesDigest } from "../../src/portable/digest.js";
import type { ProjectSession } from "../../src/portable/project/api.js";
import { ledgerKey } from "../../src/portable/store/disk-layout.js";
import { DiskProjectStore } from "../../src/portable/store/disk-store.js";
import type { PublishFaultStage } from "../../src/portable/store/store.js";
import { ledgerPath, makeFormatFixture, type FormatFixture } from "./disk-format-helpers.js";

/** An adopted project, the owner's session, and the two label sets the witnesses use. */
export interface H1World {
  fixture: FormatFixture;
  session: ProjectSession;
  compartment: string;
  restricted: string[];
}

/** One target of a direct publication. */
export interface H1Write { path: string; bytes: Buffer; pre: ObjectImage; labels: string[] }

/** Register and adopt a fresh project; the owner holds the compartment but not `restricted`. */
export async function h1World(): Promise<H1World> {
  const fixture = await makeFormatFixture();
  await fixture.adopt();
  const compartment = (await fixture.record()).compartment;
  return { fixture, session: await fixture.open(), compartment, restricted: [compartment, "restricted"] };
}

/**
 * Give every test of the calling file its OWN fresh world: made before the test,
 * handed to `use` (so the file's binding names the current test's world), and
 * cleaned up after it, whether the test passed or failed. Call it at the top
 * level of a test file.
 */
export function freshWorldPerTest(use: (world: H1World) => void): void {
  let current: H1World | null = null;
  beforeEach(async () => {
    current = await h1World();
    use(current);
  });
  afterEach(async () => {
    const made = current;
    current = null;
    await made?.fixture.cleanup();
  });
}

/** The store, interrupted the `nth` time it reaches `stage` (never, when no stage is given). */
export function storeOf(world: H1World, stage?: PublishFaultStage, nth = 1): Promise<DiskProjectStore> {
  let reached = 0;
  return DiskProjectStore.open(world.fixture.projectId, world.fixture.root, {
    registration: async () => "format-2",
    faultForTest: (at) => { if (at === stage && ++reached === nth) throw new Error(`simulated crash ${at}`); },
  });
}

/** A complete receipt for `writes`, as a source publication records it. */
function receiptFor(world: H1World, operationId: string, writes: readonly H1Write[]): ReceiptV1 {
  const digest = bytesDigest(Buffer.from(operationId));
  return {
    project: world.fixture.projectId, revision: null, operationId, kind: "source.add", intentDigest: digest, resolvedPlanDigest: digest,
    actor: world.session.principal.actor, onBehalfOf: [], policyFence: { policyRevision: 0, ticketRevision: 0 },
    published: writes.map((write) => ({ path: write.path, digest: bytesDigest(write.bytes), labels: write.labels })),
    skipped: [], consumedApprovalId: null, consumedTicketId: null, committedAt: new Date().toISOString(),
  } as ReceiptV1;
}

/** Publish `writes` as `operationId` with an in-progress identity first; rejects if interrupted. */
export async function publish(world: H1World, store: DiskProjectStore, operationId: string, writes: readonly H1Write[]): Promise<void> {
  const receipt = receiptFor(world, operationId, writes);
  const { tenant, actor } = world.session.principal;
  await store.putIdentity({
    tenant, project: world.fixture.projectId, actor, hostIncarnation: "h1", operationId, kind: "source.add",
    intentDigest: receipt.intentDigest, outcome: "in-progress", refusal: null, detail: null,
    holds: { approvalId: null, ticketId: null }, generationLease: null, resolution: null, supersedes: null,
  });
  await store.publish({ operationId, kind: "source.add", writes: writes.map((write) => ({ ...write })), tail: [], receipt });
}

/** A new restricted source write. */
export function newSource(world: H1World, name: string, text: string, labels = world.restricted): H1Write {
  return { path: `sources/${name}`, bytes: Buffer.from(text), pre: { state: "absent" }, labels };
}

/** A write replacing the `previous` bytes of `name`, which were bound to `previousLabels`. */
export function replaceSource(name: string, previous: Buffer, previousLabels: string[], text: string, labels: string[]): H1Write {
  const pre: ObjectImage = { state: "present", digest: bytesDigest(previous), byteCount: previous.byteLength, labels: previousLabels };
  return { path: `sources/${name}`, bytes: Buffer.from(text), pre, labels };
}

/** The absolute path of the retained pre-image of `bytes`. */
export function preimageFile(world: H1World, bytes: Buffer): string {
  return ledgerPath(world.fixture, "preimages", bytesDigest(bytes).slice("sha256:".length));
}

/** The absolute path of a source file. */
export function sourceFile(world: H1World, name: string): string {
  return path.join(world.fixture.root, "sources", name);
}

/** The label record of `path`, parsed, or `null`. */
export async function labelRecord(world: H1World, logicalPath: string): Promise<{ digest: string; labels: string[]; by: string } | null> {
  const key = ledgerKey(logicalPath);
  return JSON.parse(await readFile(ledgerPath(world.fixture, "labels", `${key}.json`), "utf8").catch(() => "null"));
}

/** Overwrite the label record of `path` with `record`, as a planted or damaged ledger would hold. */
export async function plantLabelRecord(world: H1World, logicalPath: string, record: string): Promise<void> {
  const file = ledgerPath(world.fixture, "labels", `${ledgerKey(logicalPath)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, record);
}

/** True when the intent file of `operationId` is still on disk. */
export async function intentPresent(world: H1World, operationId: string): Promise<boolean> {
  return readFile(ledgerPath(world.fixture, "intents", `${operationId}.json`)).then(() => true, () => false);
}

/** A source read that turns a portable refusal into its code. */
export async function readSource(session: ProjectSession, id: string): Promise<{ visible?: boolean; refused?: string }> {
  return session.project.sources.get(id).catch((error: { code?: string }) => {
    if (!error.code) throw error;
    return { refused: error.code };
  });
}

/** The two-target pair the H1 witnesses crash: `kept.md` is seeded with `old`, then replaced by `replaced`; `added.md` is created. */
export const PAIR = { old: Buffer.from("# Old\n"), replaced: "# New\n", added: "# Added\n" } as const;

/** Seed `kept.md` with the pair's old bytes as the committed operation `seed`. */
export async function seedKept(world: H1World): Promise<void> {
  await publish(world, await storeOf(world), "seed", [newSource(world, "kept.md", PAIR.old.toString())]);
}

/** The pair's writes, in order: replace `kept.md`, then create `added.md`. */
export function pairWrites(world: H1World): H1Write[] {
  return [replaceSource("kept.md", PAIR.old, world.restricted, PAIR.replaced, world.restricted), newSource(world, "added.md", PAIR.added)];
}

/** Publish `writes` as `op` and require it to be interrupted at `stage` (the `nth` time it is reached). */
export async function publishCrashing(world: H1World, writes: H1Write[], stage: PublishFaultStage, nth = 1): Promise<void> {
  await expect(publish(world, await storeOf(world, stage, nth), "op", writes)).rejects.toThrow(`simulated crash ${stage}`);
}

/** A source's bytes now, or `null` when it is absent. */
export async function sourceText(world: H1World, name: string): Promise<string | null> {
  return readFile(sourceFile(world, name), "utf8").catch(() => null);
}

/** True when the durable close record of `operationId` exists. */
export async function closeRecorded(world: H1World, operationId: string): Promise<boolean> {
  return readFile(ledgerPath(world.fixture, "closed", `${operationId}.json`)).then(() => true, () => false);
}

/**
 * Run `act` while `between` runs once, right after the resolver's FIRST
 * observation of a parked intent. Returns `act`'s outcome and how many
 * observations were made while the hook was installed.
 */
export async function afterFirstObservation<T>(between: () => Promise<unknown>, act: () => Promise<T>): Promise<{ outcome: T; observations: number }> {
  const observe = DiskProjectStore.prototype.observeIntent;
  const spy = spyOn(DiskProjectStore.prototype, "observeIntent").mockImplementationOnce(async function (this: DiskProjectStore, operationId: string) {
    const seen = await observe.call(this, operationId);
    await between();
    return seen;
  });
  try {
    const outcome = await act();
    return { outcome, observations: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}
