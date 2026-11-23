/**
 * @file test/batch/resolve-new-titles.test.ts
 * @description The batch resolver's NEW-TITLE PROJECTION (twin projects,
 * mocked provider, no network). An incremental run adds two new titles, one
 * containing the other (`Fresh Idea`, `Fresh Idea Plus`), while an existing
 * page hand-edited to mention them (once inside a code span, once beside an
 * already-linked title) is folded INBOUND, and a regenerated but not-new page
 * is both inbound and outbound:
 * - the batch compile leaves exactly the incumbent's pages, index and state;
 * - the resolve phase looks page roles up a bounded number of times (per
 *   title, not per page times title);
 * - a run indexed before the projection existed (its cursor without
 *   `newTitles`, no `tn:` rows) builds it once on resume and still matches;
 * - interruptions at the index checkpoint, while planning, while building
 *   the projection and while applying all resume to the same result.
 * Interruptions are controlled exceptions, not power loss.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { BatchRun } from "../../src/compiler/batch/run-store.js";
import { compileUnderTestProvider, compileTwins, EMBEDDINGS_OFF, makeTwin, snapshotOf, sourceNaming, stubDeterministicProvider, TWIN_CASE_TIMEOUT_MS, useTwinFixture, type Twin } from "./helpers.js";

const SOURCES = {
  "alpha.md": sourceNaming("Alpha", "Alpha Topic"),
  "beta.md": sourceNaming("Beta", "Beta Topic"),
  "gamma.md": sourceNaming("Gamma", "Gamma Topic"),
};
/** The hand-edited text of the existing Beta page: plain mentions, a code span, an existing link. */
const MENTIONS = "\n\nMentions Fresh Idea Plus first, `Fresh Idea` in code, [[Alpha Topic]] already linked, and Fresh Idea alone.\n";

/** The same text once linked: the longer overlapping title first, the code span and the existing link left alone. */
const LINKED_MENTIONS = "Mentions [[fresh-idea-plus|Fresh Idea Plus]] first, `Fresh Idea` in code, [[Alpha Topic]] already linked, and [[fresh-idea|Fresh Idea]] alone.";

let twin: Twin;

useTwinFixture(() => twin);

/** The deterministic double, except that only concepts named `Fresh …` are new to the wiki. */
function stubFreshIsNew(): void {
  stubDeterministicProvider((concept) => concept.startsWith("Fresh"));
}

/** Compile both twins, then on both: hand-edit Beta's page, change Alpha, and add Delta naming the two new titles. */
async function incrementalTwin(): Promise<void> {
  twin = await makeTwin(SOURCES);
  await compileTwins(twin, 2);
  for (const root of [twin.plain, twin.segmented]) {
    const beta = path.join(root, "wiki", "concepts", "beta-topic.md");
    await writeFile(beta, `${(await readFile(beta, "utf-8")).trimEnd()}${MENTIONS}`);
    await writeFile(path.join(root, "wiki", "queries", "saved.md"), "---\ntitle: Saved Query\n---\n\nSee [[beta]].\n");
    await writeFile(path.join(root, "sources", "alpha.md"), sourceNaming("Alpha", "Alpha Topic", "Alpha Detail"));
    await writeFile(path.join(root, "sources", "delta.md"), sourceNaming("Delta", "Fresh Idea", "Fresh Idea Plus"));
  }
  stubFreshIsNew();
  await compileUnderTestProvider(twin.plain, EMBEDDINGS_OFF);
}

/** The unmocked run-store methods every interception below delegates to. */
const ORIGINAL = { checkpoint: BatchRun.prototype.checkpoint, put: BatchRun.prototype.put };
let restoreCheckpoint: (() => void) | undefined;
let restorePut: (() => void) | undefined;

/** How one attempt's checkpoints are intercepted. */
interface CheckpointInterception {
  /** Drop `newTitles` from every cursor (a run indexed before the projection existed). */
  readonly legacy?: boolean;
  /** Throw once, with this label, at the first checkpoint whose cursor matches. */
  readonly failOnce?: readonly [(cursor: Record<string, unknown>) => boolean, string];
}

/** Intercept checkpoints (and, for a legacy attempt, drop `tn:` rows) until the spies are restored. */
function intercept(how: CheckpointInterception): void {
  stopIntercepting();
  let failed = false;
  const checkpointSpy = vi.spyOn(BatchRun.prototype, "checkpoint").mockImplementation(async function (this: BatchRun, patch) {
    const raw = patch?.cursor as Record<string, unknown> | undefined;
    if (!failed && raw !== undefined && how.failOnce?.[0](raw)) { failed = true; throw new Error(`injected failure: ${how.failOnce[1]}`); }
    const cursor = raw === undefined || !how.legacy ? raw : Object.fromEntries(Object.entries(raw).filter(([field]) => field !== "newTitles"));
    return ORIGINAL.checkpoint.call(this, cursor === raw ? patch : { ...patch!, cursor });
  });
  restoreCheckpoint = () => checkpointSpy.mockRestore();
  if (!how.legacy) return;
  const putSpy = vi.spyOn(BatchRun.prototype, "put").mockImplementation(async function (this: BatchRun, key, value) {
    if (!key.startsWith("tn:")) await ORIGINAL.put.call(this, key, value);
  });
  restorePut = () => putSpy.mockRestore();
}

/** Stop intercepting checkpoints and row writes. */
function stopIntercepting(): void {
  restorePut?.();
  restoreCheckpoint?.();
  restorePut = undefined;
  restoreCheckpoint = undefined;
}

/** Assert one injected checkpoint failure and restore its spies before the next attempt. */
async function expectInterrupted(how: CheckpointInterception, options: { embeddings: false; batchSize?: number }, message: string): Promise<void> {
  intercept(how);
  try {
    await expect(compileUnderTestProvider(twin.segmented, options)).rejects.toThrow(`injected failure: ${message}`);
  } finally { stopIntercepting(); }
}

/** The resolve phase's page-role lookups (`gr:` / `sd:` point reads) during one batch compile of the segmented twin. */
async function resolveRoleLookups(): Promise<{ lookups: number; titles: number }> {
  let resolving = false;
  let lookups = 0;
  const advance = BatchRun.prototype.advance;
  const get = BatchRun.prototype.get;
  const advanceSpy = vi.spyOn(BatchRun.prototype, "advance").mockImplementation(async function (this: BatchRun, next, cursor) {
    resolving = next === "resolve";
    return advance.call(this, next, cursor);
  });
  const getSpy = vi.spyOn(BatchRun.prototype, "get").mockImplementation(async function (this: BatchRun, key) {
    if (resolving && (key.startsWith("gr:") || key.startsWith("sd:"))) lookups += 1;
    return get.call(this, key);
  });
  try {
    await compileUnderTestProvider(twin.segmented, { batchSize: 1, ...EMBEDDINGS_OFF });
    return { lookups, titles: (await readFile(path.join(twin.segmented, "wiki", "index.md"), "utf-8")).split("[[").length - 1 };
  } finally {
    getSpy.mockRestore();
    advanceSpy.mockRestore();
  }
}

describe("the batch resolver's new-title projection", () => {
  it("links new titles inbound exactly as the incumbent, with bounded role lookups", async () => {
    await incrementalTwin();
    const { lookups, titles } = await resolveRoleLookups();
    expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
    expect(await readFile(path.join(twin.segmented, "wiki", "concepts", "beta-topic.md"), "utf-8")).toContain(LINKED_MENTIONS);
    expect(await readFile(path.join(twin.segmented, "wiki", "queries", "saved.md"), "utf-8")).toContain("beta-topic");
    expect(titles).toBeGreaterThanOrEqual(6);
    expect(lookups).toBeLessThanOrEqual(4 * titles);
  }, TWIN_CASE_TIMEOUT_MS);

  it("resumes a run indexed before the projection existed, interrupted while planning and while projecting", async () => {
    await incrementalTwin();
    await expectInterrupted({ legacy: true, failOnce: [(cursor) => cursor.indexed === true && (cursor.after as number) >= 0, "while planning"] }, { batchSize: 1, ...EMBEDDINGS_OFF }, "while planning");
    await expectInterrupted({ failOnce: [(cursor) => cursor.newTitles === true, "while projecting"] }, EMBEDDINGS_OFF, "while projecting");
    await compileUnderTestProvider(twin.segmented, EMBEDDINGS_OFF);
    expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
  }, TWIN_CASE_TIMEOUT_MS);

  it("resumes a new run interrupted at its index checkpoint and while applying", async () => {
    await incrementalTwin();
    await expectInterrupted({ failOnce: [(cursor) => cursor.indexed === true && cursor.after === -1, "at the index checkpoint"] }, { batchSize: 1, ...EMBEDDINGS_OFF }, "at the index checkpoint");
    await expectInterrupted({ failOnce: [(cursor) => typeof cursor.applied === "number" && cursor.applied >= 0, "while applying"] }, EMBEDDINGS_OFF, "while applying");
    await compileUnderTestProvider(twin.segmented, EMBEDDINGS_OFF);
    expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
  }, TWIN_CASE_TIMEOUT_MS);
});
