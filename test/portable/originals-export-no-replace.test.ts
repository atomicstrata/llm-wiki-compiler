/**
 * @file test/portable/originals-export-no-replace.test.ts
 * @description A completed hosted export cannot replace an existing user file.
 * The fixture supplies frames locally; no host, model, or network is involved.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import type { OriginalsClientV2 } from "../../src/portable/originals/client.js";
import { exportToFile } from "../../src/portable/originals/open.js";

/** A complete empty export from an in-memory host double. */
function completedClient(): OriginalsClientV2 {
  return {
    async *export() {
      yield { header: { kind: "completed" as const, count: 0, fence: {
        catalogRoot: "sha256:empty", labelEpoch: "epoch", policyRevision: 1,
      }, bytes: 0 as const } };
    },
  } as OriginalsClientV2;
}

it("preserves an occupied export destination and its completed partial", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-export-no-replace-"));
  const out = path.join(root, "existing.jsonl");
  try {
    await writeFile(out, "keep this user file");
    await expect(exportToFile(completedClient(), out)).rejects.toThrow();
    expect(await readFile(out, "utf8")).toBe("keep this user file");
    expect((await readFile(`${out}.partial`)).byteLength).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
