/**
 * @file test/operation-bundles/catalog-store.test.ts
 * @description Contract tests for the founding append-shaped workspace catalog.
 * They pin canonical line bytes, deterministic identities, exact replay, and
 * fail-closed supersession validation before adapters consume this store.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  appendCatalogRecordLocked,
  createCatalogRecord,
  findCatalogRecordByMutation,
  readCatalogStore,
  type CatalogRecord,
} from "../../src/operation-bundles/catalog-store.js";
import type { MutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();
const CREATED_AT = "2026-07-18T00:00:00.000Z";

/** Return one structurally valid deterministic mutation identity. */
function mutation(seed: string): MutationId {
  return `opm_${createHash("sha256").update(seed).digest("hex")}`;
}

/** Build one canonical catalog record through the public store constructor. */
function record(seed: string, overrides: Partial<Parameters<typeof createCatalogRecord>[0]> = {}): CatalogRecord {
  return createCatalogRecord({
    logicalRecordId: "source-one",
    mutationId: mutation(seed),
    payload: { title: "Source one", rank: 1 },
    createdAt: CREATED_AT,
    ...overrides,
  });
}

/** Publish exact hostile catalog lines without using the store writer. */
async function plant(records: readonly CatalogRecord[]): Promise<void> {
  const paths = operationPaths(root.dir, "research");
  await mkdir(paths.workspaceRoot, { recursive: true });
  const body = Buffer.concat(records.flatMap((item) => [canonicalBytes(item), Buffer.from("\n")]));
  await writeFile(paths.catalogFile, body);
}

describe("catalog store", () => {
  it("writes one canonical line with a deterministic physical identity", async () => {
    const candidate = record("first");

    expect(record("first").physicalRecordId).toBe(candidate.physicalRecordId);
    expect(candidate.physicalRecordId).toMatch(/^cat_[0-9a-f]{64}$/);
    await expect(appendCatalogRecordLocked(root.dir, "research", candidate)).resolves.toBe("created");

    const paths = operationPaths(root.dir, "research");
    expect(await readFile(paths.catalogFile)).toEqual(Buffer.concat([canonicalBytes(candidate), Buffer.from("\n")]));
    const read = await readCatalogStore(root.dir, "research");
    expect(read).toEqual({ status: "ok", records: [candidate] });
    if (read.status === "ok") expect(findCatalogRecordByMutation(read.records, candidate.mutationId)).toEqual(candidate);
  });

  it("treats exact mutation replay as same and mismatched replay as conflict", async () => {
    const candidate = record("replay");
    await appendCatalogRecordLocked(root.dir, "research", candidate);

    await expect(appendCatalogRecordLocked(root.dir, "research", candidate)).resolves.toBe("same");
    const mismatched = record("replay", { payload: { title: "changed" } });
    await expect(appendCatalogRecordLocked(root.dir, "research", mismatched)).rejects.toThrow(/mutation.*conflict/i);

    const read = await readCatalogStore(root.dir, "research");
    expect(read.status === "ok" ? read.records : []).toEqual([candidate]);
  });

  it("rejects missing predecessors and supersession forks", async () => {
    const base = record("base"), missing = record("missing", { supersedesRecordId: record("ghost").physicalRecordId });
    await expect(appendCatalogRecordLocked(root.dir, "research", missing)).rejects.toThrow(/predecessor/i);

    await appendCatalogRecordLocked(root.dir, "research", base);
    const successor = record("successor", { supersedesRecordId: base.physicalRecordId });
    await appendCatalogRecordLocked(root.dir, "research", successor);
    const fork = record("fork", { supersedesRecordId: base.physicalRecordId });
    await expect(appendCatalogRecordLocked(root.dir, "research", fork)).rejects.toThrow(/fork/i);
  });

  it("rejects cycles and duplicate mutation identities on read", async () => {
    const firstBase = record("cycle-a"), secondBase = record("cycle-b");
    const first = { ...firstBase, supersedesRecordId: secondBase.physicalRecordId };
    const second = { ...secondBase, supersedesRecordId: firstBase.physicalRecordId };
    await plant([first, second]);

    const cycle = await readCatalogStore(root.dir, "research");
    expect(cycle).toMatchObject({ status: "invalid" });
    expect(cycle.status === "invalid" ? cycle.detail : "").toMatch(/cycle/i);

    await plant([firstBase, firstBase]);
    const duplicate = await readCatalogStore(root.dir, "research");
    expect(duplicate).toMatchObject({ status: "invalid" });
    expect(duplicate.status === "invalid" ? duplicate.detail : "").toMatch(/mutation|physical/i);
  });

  it("rejects a successor that appears before its predecessor", async () => {
    const base = record("ordered-base");
    const successor = record("ordered-next", { supersedesRecordId: base.physicalRecordId });
    await plant([successor, base]);

    const read = await readCatalogStore(root.dir, "research");
    expect(read).toMatchObject({ status: "invalid" });
    expect(read.status === "invalid" ? read.detail : "").toMatch(/predecessor|order/i);
  });

  it("accepts a long append-ordered supersession chain", async () => {
    const chain: CatalogRecord[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const prior = chain.at(-1)?.physicalRecordId;
      chain.push(record(`chain-${index}`, {
        logicalRecordId: "long-chain",
        ...(prior === undefined ? {} : { supersedesRecordId: prior }),
      }));
    }
    await plant(chain);

    const read = await readCatalogStore(root.dir, "research");
    expect(read.status === "ok" ? read.records.length : read).toBe(chain.length);
  });
});
