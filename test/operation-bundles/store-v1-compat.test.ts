/**
 * @file test/operation-bundles/store-v1-compat.test.ts
 * @description Task 2 tests that ordinary (non-bundle) relation and event APIs
 * remain byte-unchanged at header v1, and that the explicit operation-version
 * upgrade rewrites only the header — preserving every record byte and its order —
 * while creating an absent store at v2 and refusing an unsupported header.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RELATIONS_FILE, EVENTS_FILE } from "../../src/utils/constants.js";
import { appendRelation } from "../../src/relations/store.js";
import { readRelations } from "../../src/relations/store-read.js";
import { ensureRelationOperationVersionLocked } from "../../src/relations/store-version.js";
import { appendEvent } from "../../src/events/store.js";
import { ensureEventOperationVersionLocked } from "../../src/events/store-version.js";
import type { EntityId } from "../../src/profile/types.js";
import { relatedProfile as profile, RELATED_INPUT as input } from "../fixtures/profile-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "v1-compat-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function header(file: string): Promise<{ version: number; recordBytes: string }> {
  const raw = await readFile(path.join(root, file), "utf8");
  const newline = raw.indexOf("\n");
  return { version: JSON.parse(raw.slice(0, newline)).schemaVersion, recordBytes: raw.slice(newline + 1) };
}

describe("ordinary APIs stay at v1", () => {
  it("keeps a fresh relation store at header v1", async () => {
    await appendRelation(root, profile(), input);
    expect((await header(RELATIONS_FILE)).version).toBe(1);
    expect((await readRelations(root)).relations).toHaveLength(1);
  });

  it("keeps a fresh event store at header v1", async () => {
    await appendEvent(root, { type: "connector-fetch", origin: "sdk", payload: {}, at: "2026-07-19T00:00:00.000Z" });
    expect((await header(EVENTS_FILE)).version).toBe(1);
  });
});

describe("operation-version upgrade", () => {
  it("rewrites only the relation header, preserving record bytes and order", async () => {
    await appendRelation(root, profile(), input);
    await appendRelation(root, profile(), { type: "related", from: "experiments/c" as EntityId, to: "ideas/d" as EntityId });
    const before = await header(RELATIONS_FILE);
    await ensureRelationOperationVersionLocked(root);
    const after = await header(RELATIONS_FILE);
    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
    expect(after.recordBytes).toBe(before.recordBytes);
  });

  it("is idempotent on an already-upgraded relation store", async () => {
    await appendRelation(root, profile(), input);
    await ensureRelationOperationVersionLocked(root);
    const first = await header(RELATIONS_FILE);
    await ensureRelationOperationVersionLocked(root);
    expect(await header(RELATIONS_FILE)).toEqual(first);
  });

  it("creates an absent event store header-only at v2", async () => {
    await ensureEventOperationVersionLocked(root);
    const upgraded = await header(EVENTS_FILE);
    expect(upgraded.version).toBe(2);
    expect(upgraded.recordBytes).toBe("");
  });

  it("refuses an unsupported relation header version", async () => {
    await mkdir(path.join(root, "wiki", "graph"), { recursive: true });
    await writeFile(path.join(root, RELATIONS_FILE), `${JSON.stringify({ kind: "relation-store-header", schemaVersion: 9 })}\n`);
    await expect(ensureRelationOperationVersionLocked(root)).rejects.toThrow();
  });
});
