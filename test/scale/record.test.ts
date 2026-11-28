/**
 * @file test/scale/record.test.ts
 * @description The scale record on disk: absence, a validated round trip, and
 * FAIL-CLOSED reads for every malformed, oversized, linked, escaping or
 * well-formed-but-contradictory record, plus the cheap presence probe and the
 * rule that an invalid record is never written.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { PreparePendingV1, ScaleRecordV1 } from "../../src/scale/contracts.js";
import { planScale } from "../../src/scale/plan.js";
import { diskScaleRecordIo, hasScaleRecord, readScaleRecord, writeScaleRecordFrom } from "../../src/scale/record.js";
import { nextRecord } from "../../src/scale/transition.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-record-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const SMALL = nextRecord(null, planScale({ sizeBytes: 5_000_000, documents: 100 }));
const LARGE = nextRecord(null, planScale({ sizeBytes: 50_000_000, documents: 2_000 }));
const HUGE = nextRecord(null, planScale({ sizeBytes: 2_000_000_000_000 }));
const COUNTED = nextRecord(null, planScale({ documents: 100 }));
const LARGE_PENDING = LARGE.pending as PreparePendingV1;

/** Write raw record text at the record's location. */
async function plant(text: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "scale.json"), text);
}

/** The read kind after planting `value` as JSON. */
async function kindAfter(value: unknown): Promise<string> {
  await plant(JSON.stringify(value));
  return (await readScaleRecord(root)).kind;
}

describe("reading a record that is absent or valid", () => {
  it("treats no private directory and no leaf as absent, cheaply", async () => {
    expect([await readScaleRecord(root), await hasScaleRecord(root)]).toEqual([{ kind: "absent" }, false]);
    await mkdir(path.join(root, ".llmwiki"));
    expect([await readScaleRecord(root), await hasScaleRecord(root)]).toEqual([{ kind: "absent" }, false]);
  });

  it("round-trips a validated record through one atomic write", async () => {
    await writeScaleRecordFrom(diskScaleRecordIo(root), COUNTED);
    expect(await readScaleRecord(root)).toEqual({ kind: "ok", record: COUNTED });
    await writeScaleRecordFrom(diskScaleRecordIo(root), LARGE);
    expect(await readScaleRecord(root)).toEqual({ kind: "ok", record: LARGE });
    expect(await hasScaleRecord(root)).toBe(true);
  });
});

describe("failing closed on a record whose content cannot be trusted", () => {
  it("rejects malformed JSON, unknown keys, other versions and out-of-range numbers", async () => {
    await plant("{ not json");
    expect((await readScaleRecord(root)).kind).toBe("unreadable");
    const cases: unknown[] = [
      { ...SMALL, extra: 1 }, { ...SMALL, version: 2 }, { ...SMALL, revision: 0 }, { ...SMALL, revision: 2 ** 53 },
      { ...SMALL, requested: { ...SMALL.requested, documentsBasis: "guess" } }, { ...SMALL, active: { ...SMALL.active, sinceRevision: 9 } },
      { ...LARGE, pending: { ...LARGE.pending!, revision: 7 } }, { ...LARGE, pending: { ...LARGE_PENDING, steps: [...LARGE_PENDING.steps].reverse() } },
      { ...HUGE, pending: { ...HUGE.pending!, missing: [] } }, null, [],
    ];
    for (const value of cases) expect(await kindAfter(value), JSON.stringify(value)).toBe("unreadable");
  });

  it("rejects well-formed records that contradict their own estimate", async () => {
    const cases: unknown[] = [
      { ...HUGE, pending: null },
      { ...LARGE, pending: null },
      { ...SMALL, pending: LARGE.pending === null ? null : { ...LARGE.pending, revision: SMALL.revision } },
      { ...SMALL, requested: { ...SMALL.requested, documentsBasis: "derived" } },
      { ...COUNTED, requested: { ...COUNTED.requested, sizeBytes: COUNTED.requested.sizeBytes + 1 } },
      { ...COUNTED, requested: { ...COUNTED.requested, documentsBasis: "derived" } },
      { ...COUNTED, requested: { ...COUNTED.requested, documents: 2 ** 50, sizeBytes: 1 } },
      { ...HUGE, pending: { ...HUGE.pending!, exceeds: ["documents"] } },
    ];
    for (const value of cases) expect(await kindAfter(value), JSON.stringify(value)).toBe("unreadable");
  });

});

describe("failing closed on where the record is, and never writing an invalid one", () => {
  it("rejects an oversized leaf, a linked leaf and an escaping private directory", async () => {
    await plant(" ".repeat(17 * 1024));
    expect((await readScaleRecord(root)).kind).toBe("unreadable");
    await rm(path.join(root, ".llmwiki"), { recursive: true });
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(path.join(root, "elsewhere.json"), JSON.stringify(SMALL));
    await symlink(path.join(root, "elsewhere.json"), path.join(root, ".llmwiki", "scale.json"));
    expect((await readScaleRecord(root)).kind).toBe("unreadable");
    const outside = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-outside-"));
    await rm(path.join(root, ".llmwiki"), { recursive: true });
    await symlink(outside, path.join(root, ".llmwiki"));
    expect([await hasScaleRecord(root), (await readScaleRecord(root)).kind]).toEqual([true, "unreadable"]);
    await rm(outside, { recursive: true, force: true });
    expect([await hasScaleRecord(root), (await readScaleRecord(root)).kind]).toEqual([true, "unreadable"]);
  });

  it("never writes an invalid record", async () => {
    const invalid = { ...SMALL, revision: -1 } as unknown as ScaleRecordV1;
    await expect(writeScaleRecordFrom(diskScaleRecordIo(root), invalid)).rejects.toThrow();
    expect(await hasScaleRecord(root)).toBe(false);
  });
});
