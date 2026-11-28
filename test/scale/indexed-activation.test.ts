/**
 * @file test/scale/indexed-activation.test.ts
 * @description Expected scale driving `local-indexed` through the REAL set and
 * prepare bodies on real disk (only free space is supplied): incumbent pages,
 * sources and events are prepared into the indexed stores and served after
 * activation; a 100-document estimate keeps version 1 bytes and creates no
 * indexed store; an old version 1 unavailable record stays blocking under a
 * read-only status and is re-planned explicitly by prepare; an unloadable
 * custom profile is recorded unavailable before any effect (a loadable one
 * is prepared through the typed entity catalog: `test/catalog/typed-catalog.test.ts`); lowering keeps the
 * indexed layout; a step that cannot prove its input parks with the
 * incumbent files still authoritative, and resumes once repaired; a record
 * changed under a transition refuses the next conditional write.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { appendEvent } from "../../src/events/store.js";
import { readEvents } from "../../src/events/store-read.js";
import { planScale } from "../../src/scale/plan.js";
import { serializeScaleRecord } from "../../src/scale/record-schema.js";
import { nextRecord as nextV1 } from "../../src/scale/transition.js";
import { diskScaleTransitionSteps, prepareExpectedScaleWith, scaleStatus, setExpectedScaleWith, type ScaleTransitionSteps } from "../../src/scale/transition.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import { writeCorpus } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-indexed-act-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const EVENT = { type: "connector-fetch" as const, origin: "test", payload: {}, at: "2026-10-26T00:00:00.000Z" };
/** Disk steps with ample free space (the only thing supplied), plus an optional checkpoint hook. */
function steps(checkpoint?: ScaleTransitionSteps["checkpoint"]): ScaleTransitionSteps {
  return { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER }, ...(checkpoint ? { checkpoint } : {}) };
}
/** The record text on disk. */
const recordText = () => readFile(path.join(root, ".llmwiki", "scale.json"), "utf8");

describe("activation through set and prepare", () => {
  it("prepares the incumbent content into the indexed stores and serves it after activation", async () => {
    await writeCorpus(root, 12, 7);
    for (let n = 0; n < 3; n += 1) await appendEvent(root, EVENT);
    const legacyEvents = await readFile(path.join(root, EVENTS_FILE));
    const report = await setExpectedScaleWith(steps(), { request: { documents: 8_000 } });
    expect([report.readiness, report.record?.version, report.record?.active.architecture]).toEqual(["ready", 2, "local-indexed"]);
    const wiki = createWikiCore({ root });
    expect((await wiki.listPages({ limit: 5 })).catalog).toBeDefined();
    expect(await wiki.catalog.status()).toMatchObject({ active: true, counts: { concepts: 12, sources: 7 } });
    expect((await readEvents(root)).events).toHaveLength(3);
    await appendEvent(root, EVENT);
    expect(await readFile(path.join(root, EVENTS_FILE))).toEqual(legacyEvents);
    expect(await wiki.catalog.verify()).toMatchObject({ ok: true, storesFailed: 0 });
  });

  it("keeps a 100-document estimate on version 1 bytes with no indexed store", async () => {
    const report = await setExpectedScaleWith(steps(), { request: { documents: 100 } });
    expect(report.record?.version).toBe(1);
    expect(await recordText()).toBe(serializeScaleRecord(nextV1(null, planScale({ documents: 100 })) as never));
    expect(await readdir(path.join(root, ".llmwiki"))).not.toContain("indexed");
  });
});

describe("compatibility and eligibility", () => {
  it("leaves an old version 1 unavailable record blocking under status, and prepare re-plans it explicitly", async () => {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    const v1 = { version: 1, revision: 1, requested: planScale({ documents: 5_000 }).requested, active: { architecture: "local-standard", sinceRevision: 1 },
      pending: { kind: "unavailable", revision: 1, exceeds: ["documents", "bytes"], missing: ["segmented-relation-store", "segmented-event-store", "sharded-vector-store", "durable-paged-catalog", "durable-hosted-backend"] } };
    await writeFile(path.join(root, ".llmwiki", "scale.json"), serializeScaleRecord(v1 as never));
    const before = await recordText();
    expect(await scaleStatus(root)).toMatchObject({ readiness: "unavailable", replanAvailable: true });
    expect(await recordText()).toBe(before);
    const prepared = await prepareExpectedScaleWith(steps());
    expect([prepared.readiness, prepared.record?.version, prepared.record?.revision, prepared.superseded]).toEqual(["ready", 2, 2, true]);
  });

  it("records an unloadable custom profile as unavailable before any indexed effect", async () => {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki", "profile.json"), "{ not a profile");
    const report = await setExpectedScaleWith(steps(), { request: { documents: 8_000 } });
    expect(report).toMatchObject({ readiness: "unavailable", record: { pending: { exceeds: [], missing: ["profile-entity-catalog"] } } });
    expect(await readdir(path.join(root, ".llmwiki"))).not.toContain("indexed");
  });

  it("keeps the indexed layout when the estimate is lowered", async () => {
    await setExpectedScaleWith(steps(), { request: { documents: 8_000 } });
    const lowered = await setExpectedScaleWith(steps(), { request: { documents: 100 } });
    expect([lowered.readiness, lowered.record?.version, lowered.record?.active.architecture]).toEqual(["ready", 2, "local-indexed"]);
  });
});

describe("parking, resuming and conditional writes", () => {
  it("parks a step that cannot prove its input with the incumbent files authoritative, then resumes", async () => {
    await appendEvent(root, EVENT);
    const head = path.join(root, ".llmwiki", "events.head");
    const sealed = await readFile(head, "utf8");
    await writeFile(head, "f".repeat(64));
    expect((await setExpectedScaleWith(steps(), { request: { documents: 8_000 } })).readiness).toBe("parked");
    expect((await scaleStatus(root)).record?.active.architecture).toBe("local-standard");
    await writeFile(head, sealed);
    expect((await prepareExpectedScaleWith(steps())).record?.active.architecture).toBe("local-indexed");
  });

  it("refuses the next conditional write when the record changed under a transition", async () => {
    await expect(setExpectedScaleWith(steps(async (stage) => {
      if (stage === "after-request") await writeFile(path.join(root, ".llmwiki", "scale.json"), serializeScaleRecord(nextV1(null, planScale({ documents: 50 })) as never));
    }), { request: { documents: 8_000 } })).rejects.toMatchObject({ code: "scale_revision_conflict" });
  });
});
