/**
 * @file test/scale/indexed-gating.test.ts
 * @description Gated paths on an ACTIVE `local-indexed` project, on real
 * disk. Connector runs are profile-gated BEFORE any effect: a project without
 * a typed profile (the only kind `local-indexed` admits) refuses a connector
 * run before the fetch, the lock or any write, so no connector event or
 * candidate reaches the segmented stores. The project tree is byte- and
 * stamp-identical afterwards.
 */

import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { runConnector } from "../../src/connectors/run.js";
import { activateIndexed, writeCorpus } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-indexed-gate-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Every path under `dir` with its size, mtime and (for files) bytes. */
async function treeState(dir: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of await readdir(dir, { recursive: true })) {
    const full = path.join(dir, name);
    const info = await lstat(full, { bigint: true });
    state[name] = `${info.size}:${info.mtimeNs}:${info.isFile() ? (await readFile(full)).toString("base64") : "dir"}`;
  }
  return state;
}

describe("connector runs on an indexed project", () => {
  it("refuse at the indexed gate before any fetch, lock or write", async () => {
    await writeCorpus(root, 5, 3);
    await activateIndexed(root);
    const before = await treeState(root);
    const fetcher = vi.fn();
    const result = await runConnector(root, "fixture", { id: "x" }, { fetcher });
    expect(result).toEqual({ kind: "refused", reason: "connectors are unavailable on a local-indexed project" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await treeState(root)).toEqual(before);
  });
});
