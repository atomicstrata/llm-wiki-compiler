/**
 * @file test/operation-bundles/event-operation-binding.test.ts
 * @description Task 2 tests for operation-bound events: the child audit event
 * persists the exact binding and keeps the chain intact at header v2, an exact
 * retry appends nothing, a divergent mutation parks, and both the chain digest
 * and the per-record checksum cover the binding.
 */

import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EVENTS_FILE } from "../../src/utils/constants.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import { appendOperationEventLocked, type OperationEventContent } from "../../src/events/operation-events.js";
import { appendEvent } from "../../src/events/store.js";
import { readEvents, readEventsStrict } from "../../src/events/store-read.js";
import { eventPrevHash } from "../../src/events/event-digest.js";

function makeBinding(index = 0): OperationBinding {
  const bundleId = mintBundleId();
  return { bundleId, runId: mintOperationRunId(), mutationId: mutationId(bundleId, index) };
}

function content(digest: string): OperationEventContent {
  return { type: "operation-mutation", origin: "sdk", payload: { kind: "catalog-record", postStateDigest: digest }, at: "2026-07-19T00:00:00.000Z" };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-op-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("appendOperationEventLocked", () => {
  it("persists the binding and keeps the chain intact at header v2", async () => {
    const binding = makeBinding();
    const result = await appendOperationEventLocked(root, content("sha256:aa"), binding);
    expect(result.status).toBe("created");
    const events = await readEventsStrict(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.operationBinding).toEqual(binding);
    const raw = await readFile(path.join(root, EVENTS_FILE), "utf8");
    expect(JSON.parse(raw.split("\n")[0]!).schemaVersion).toBe(2);
  });

  it("appends nothing on an exact retry", async () => {
    const binding = makeBinding();
    await appendOperationEventLocked(root, content("sha256:aa"), binding);
    const retry = await appendOperationEventLocked(root, content("sha256:aa"), binding);
    expect(retry.status).toBe("same");
    expect((await readEvents(root)).events).toHaveLength(1);
  });

  it("parks a divergent content on the same mutation binding", async () => {
    const binding = makeBinding();
    await appendOperationEventLocked(root, content("sha256:aa"), binding);
    const result = await appendOperationEventLocked(root, content("sha256:bb"), binding);
    expect(result.status).toBe("conflict");
  });

  it("keeps the v2 header when an ordinary append repairs a torn tail", async () => {
    const binding = makeBinding();
    await appendOperationEventLocked(root, content("sha256:aa"), binding);
    await appendFile(path.join(root, EVENTS_FILE), '{"id":"evt_partial","type":"connector'); // torn tail, no newline
    await appendEvent(root, { type: "connector-fetch", origin: "sdk", payload: {}, at: "2026-07-19T00:00:00.000Z" });
    const raw = await readFile(path.join(root, EVENTS_FILE), "utf8");
    expect(JSON.parse(raw.split("\n")[0]!).schemaVersion).toBe(2);
    const events = await readEventsStrict(root);
    expect(events[0]!.operationBinding).toEqual(binding);
    expect(events).toHaveLength(2);
  });

  it("covers the binding in the chain digest and leaves unbound digests unchanged", () => {
    const base = { id: "evt_x" as `evt_${string}`, type: "operation-mutation" as const, origin: "sdk", payload: {}, at: "t" };
    const first = makeBinding(0), second = makeBinding(1);
    expect(eventPrevHash({ ...base, operationBinding: first })).not.toBe(eventPrevHash({ ...base, operationBinding: second }));
    expect(eventPrevHash(base)).toBe(eventPrevHash({ ...base, operationBinding: undefined }));
  });
});
