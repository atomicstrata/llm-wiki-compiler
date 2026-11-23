/**
 * @file test/batch/snapshot-query-parity.test.ts
 * @description The twin parity snapshot must observe saved-query page differences.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { snapshotOf } from "./helpers.js";

it("includes saved-query page bytes in the batch parity snapshot", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "llmwiki-query-parity-"));
  const plain = path.join(base, "plain");
  const segmented = path.join(base, "segmented");
  try {
    for (const root of [plain, segmented]) await mkdir(path.join(root, "wiki", "queries"), { recursive: true });
    await writeFile(path.join(plain, "wiki", "queries", "saved.md"), "---\ntitle: Saved Query\n---\n\nExpected.\n");
    await writeFile(path.join(segmented, "wiki", "queries", "saved.md"), "---\ntitle: Saved Query\n---\n\nChanged.\n");
    expect(await snapshotOf(segmented)).not.toEqual(await snapshotOf(plain));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
