/**
 * @file test/scale/indexed-interruption.test.ts
 * @description A `local-indexed` preparation killed with a REAL SIGKILL, in a
 * separate process, right after each durable checkpoint (the request, the
 * preflight, the catalog build, the history import, the vector import and
 * the final verification). After each kill the project is still on the
 * incumbent files (the record is not active, listings and events read the
 * files), and `prepare` in this process resumes, re-verifies and activates,
 * with the incumbent files untouched throughout. Process-crash evidence only,
 * not power-loss qualification.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll, beforeEach } from "../config/storage-profile-hooks.js";
import { appendEvent } from "../../src/events/store.js";
import { readEvents } from "../../src/events/store-read.js";
import { diskScaleTransitionSteps, prepareExpectedScaleWith, scaleStatus } from "../../src/scale/transition.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import { bundleChild, runChild } from "../helpers-child-process.js";
import { writeCorpus } from "../catalog/helpers.js";

let script: string;
let root: string;
beforeAll(async () => { script = await bundleChild("test/scale/fixtures/prepare-child.ts"); });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-indexed-kill-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const STAGES = ["after-request", "after-capacity-preflight", "after-catalog-build", "after-history-import", "after-vector-shards", "after-activation-verify"];
const EVENT = { type: "connector-fetch" as const, origin: "test", payload: {}, at: "2026-10-26T00:00:00.000Z" };

describe("SIGKILL at every indexed checkpoint", () => {
  it.each(STAGES)("leaves the incumbent files authoritative after %s, and prepare resumes to active", async (stage) => {
    await writeCorpus(root, 30, 10);
    for (let n = 0; n < 4; n += 1) await appendEvent(root, EVENT);
    const legacy = await readFile(path.join(root, EVENTS_FILE));
    const end = await runChild(script, [root, stage]);
    expect(end.signal).toBe("SIGKILL");
    expect((await scaleStatus(root)).record?.active.architecture).toBe("local-standard");
    expect((await readEvents(root)).events).toHaveLength(4);
    const resumed = await prepareExpectedScaleWith({ ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER } });
    expect([resumed.readiness, resumed.record?.active.architecture]).toEqual(["ready", "local-indexed"]);
    expect(await createWikiCore({ root }).catalog.status()).toMatchObject({ counts: { concepts: 30, sources: 10 } });
    expect((await readEvents(root)).events).toHaveLength(4);
    expect(await readFile(path.join(root, EVENTS_FILE))).toEqual(legacy);
  }, 60_000);
});
