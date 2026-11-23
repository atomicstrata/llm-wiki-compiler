/**
 * @file test/scale/sdk-init.test.ts
 * @description Explicit creation and the SDK surface of the expected scale.
 *
 * `initWikiCore` / `initWiki` create a not-yet-existing root or re-verify an
 * existing one, scaffold only `.llmwiki` and `sources/` as real confined
 * directories, prove the project lock works, register and adopt nothing, and
 * record about 100 documents as ready on `local-standard`; without an
 * estimate they write no record. Invalid input creates nothing, and linked or
 * non-directory setup refuses. `wiki.scale` sets, reports and prepares with
 * typed refusals, records an unavailable estimate that blocks the next write,
 * and allowlists its input.
 */

import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ScaleRefusalError } from "../../src/scale/contracts.js";
import { ScaleGateError } from "../../src/scale/gate.js";
import { createWikiCore, initWikiCore } from "../../src/sdk/core.js";
import { initWiki } from "../../src/sdk/wiki.js";

let base: string;
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-init-")); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const TEXT = "A paragraph long enough to satisfy the minimum content rule for an ingested source. ".repeat(4);
/** Whether `at` is a real directory, not a link. */
const isRealDir = async (at: string): Promise<boolean> => { const info = await lstat(at); return info.isDirectory() && !info.isSymbolicLink(); };

describe("creating a project explicitly", () => {
  it("creates a missing root for about 100 documents with only local files and a ready local-standard record", async () => {
    const root = path.join(base, "new", "wiki");
    const wiki = await initWikiCore({ root, expectedScale: { documents: 100 } });
    expect([await isRealDir(path.join(root, ".llmwiki")), await isRealDir(path.join(root, "sources"))]).toEqual([true, true]);
    expect((await readdir(path.join(root, ".llmwiki"))).sort()).toEqual(["scale.json"]);
    const status = await wiki.scale.status();
    expect([status.readiness, status.record?.active.architecture, status.record?.requested.sizeBasis]).toEqual(["ready", "local-standard", "derived"]);
    await wiki.ingestText({ title: "First", text: TEXT });
    expect(await readdir(path.join(root, "sources"))).toHaveLength(1);
  });

  it("re-verifies an existing directory without an estimate and writes no record", async () => {
    const wiki = await initWiki({ root: base });
    expect((await wiki.scale.status()).readiness).toBe("unconfigured");
    expect(await readdir(path.join(base, ".llmwiki"))).toEqual([]);
  });

  it("creates nothing for invalid input and refuses linked or non-directory setup", async () => {
    const missing = path.join(base, "never");
    await expect(initWikiCore({ root: missing, expectedScale: { sizeBytes: 0 } })).rejects.toBeInstanceOf(ScaleRefusalError);
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const outside = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-outside-"));
    await symlink(outside, path.join(base, "sources"));
    await expect(initWikiCore({ root: base, expectedScale: { documents: 100 } })).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
    const fileRoot = path.join(base, "file-private");
    await mkdir(fileRoot);
    await writeFile(path.join(fileRoot, ".llmwiki"), "not a directory");
    await expect(initWikiCore({ root: fileRoot })).rejects.toThrow();
  });
});

describe("the wiki.scale SDK surface", () => {
  it("throws typed refusals with nothing changed, and allowlists its input", async () => {
    const wiki = createWikiCore({ root: base });
    await expect(wiki.scale.set({ sizeBytes: -1 })).rejects.toMatchObject({ code: "scale_invalid_request" });
    await expect(wiki.scale.set({} as never)).rejects.toMatchObject({ code: "scale_invalid_request" });
    expect((await wiki.scale.set({ documents: 100, expectedRevision: 0, extra: true } as never)).readiness).toBe("ready");
    await expect(wiki.scale.set({ documents: 100, expectedRevision: 0 })).rejects.toMatchObject({ code: "scale_revision_conflict" });
    expect((await wiki.scale.status()).record?.revision).toBe(1);
  });

  it("records an unavailable estimate that blocks the next write, until a lower one supersedes it", async () => {
    const wiki = createWikiCore({ root: base });
    const report = await wiki.scale.set({ documents: 5_000_000 });
    expect(report.record?.pending).toMatchObject({ kind: "unavailable", exceeds: ["documents", "bytes"] });
    expect((await wiki.scale.prepare()).readiness).toBe("unavailable");
    await expect(wiki.ingestText({ title: "Blocked", text: TEXT })).rejects.toBeInstanceOf(ScaleGateError);
    expect((await wiki.scale.set({ documents: 100 })).readiness).toBe("ready");
    await wiki.ingestText({ title: "Allowed", text: TEXT });
  });
});
