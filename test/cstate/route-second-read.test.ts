/**
 * @file test/cstate/route-second-read.test.ts
 * @description The compile-state and typed-catalog capability reads fail
 * CLOSED beside indexed stores even when the scale record disappears or turns
 * unreadable BETWEEN the indexed route's read and the capability read: the
 * second read refuses with `scale-state-unreadable` instead of answering
 * `absent` (which would serve `state.json` in place of the store). Without
 * indexed stores, a missing record is simply `absent`.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";

const reads = { next: [] as unknown[] };
// Copy the real module first: vi.mock patches it in place, so a later read would see the mock.
const actual = { ...(await import("../../src/scale/record.js")) };
vi.mock("../../src/scale/record.js", async () => {
  return { ...actual, readScaleRecord: vi.fn(async (root: string) => (reads.next.length > 0 ? reads.next.shift() : actual.readScaleRecord(root))) };
});

const { capabilityStatus } = await import("../../src/scale/capability-status.js");
const { typedCatalogStatus } = await import("../../src/catalog/typed-admission.js");

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-second-read-")); reads.next = []; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("a capability read beside indexed stores", () => {
  it.each([[{ kind: "absent" }], [{ kind: "unreadable", reason: "torn" }]])("refuses when the record reads %o", async (read) => {
    await mkdir(path.join(root, ".llmwiki", "indexed", "cstate"), { recursive: true });
    reads.next = [read, read];
    await expect(capabilityStatus(root, "segmented-compile-state-1")).rejects.toMatchObject({ block: "scale-state-unreadable" });
    await expect(typedCatalogStatus(root)).rejects.toMatchObject({ block: "scale-state-unreadable" });
  });

  it("is absent without indexed stores", async () => {
    reads.next = [{ kind: "absent" }];
    await expect(capabilityStatus(root, "segmented-compile-state-1")).resolves.toBe("absent");
  });
});
