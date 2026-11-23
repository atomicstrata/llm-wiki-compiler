/**
 * @file test/catalog/failclosed.test.ts
 * @description An active `local-indexed` catalog fails closed on real disk:
 * a lost scale record with indexed stores refuses reads AND gated writes
 * (never falling back to the incumbent files); a missing catalog manifest
 * refuses instead of serving an empty catalog; malformed catalog facts are
 * typed corruption; a linked or swapped nested source directory never
 * leaks an outside file into a listing; and a non-default profile is refused.
 */

import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ingestTextSource } from "../../src/commands/ingest.js";
import { routedListPages, routedListSources } from "../../src/catalog/routes.js";
import { assertProfileChangeAllowed } from "../../src/indexed/profile-guard.js";
import { IndexedStoreError } from "../../src/segments/contracts.js";
import { ScaleGateError } from "../../src/scale/gate.js";
import { activateIndexed, sourceText, writeCorpus } from "./helpers.js";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-closed-"));
  outside = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-outside-"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

const TEXT = "A paragraph long enough to satisfy the minimum content rule for an ingested source. ".repeat(4);
const manifest = () => path.join(root, ".llmwiki", "indexed", "catalog", "manifest.json");

describe("lost authority", () => {
  it("refuses listings and a gated ingest when the scale record is gone, leaving the files as they were", async () => {
    await writeCorpus(root, 3, 3);
    await activateIndexed(root);
    await rm(path.join(root, ".llmwiki", "scale.json"));
    await expect(routedListPages(root)).rejects.toMatchObject({ block: "scale-state-unreadable" });
    await expect(ingestTextSource(root, { title: "Late", text: TEXT })).rejects.toBeInstanceOf(ScaleGateError);
    await expect(readFile(path.join(root, "sources", "late.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an active project with no catalog manifest, and malformed catalog facts", async () => {
    await writeCorpus(root, 3, 0);
    await activateIndexed(root);
    const original = await readFile(manifest(), "utf8");
    await rename(manifest(), `${manifest()}.moved`);
    await expect(routedListPages(root)).rejects.toMatchObject({ code: "indexed_store_corrupt" });
    await writeFile(manifest(), original.replace('"counts":{', '"counts":null,"x":{'));
    await expect(routedListPages(root)).rejects.toBeInstanceOf(IndexedStoreError);
  });
});

describe("a partial catalog under an active record", () => {
  it("refuses a building catalog rather than serving it as activated", async () => {
    await writeCorpus(root, 3, 0);
    await activateIndexed(root);
    const text = await readFile(manifest(), "utf8");
    await writeFile(manifest(), text.replace('"phase":"ready"', '"phase":"building"'));
    await expect(routedListPages(root)).rejects.toMatchObject({ code: "indexed_store_corrupt", message: expect.stringContaining("never finished its first build") });
  });
});

describe("confinement", () => {
  it("never catalogues or returns a file behind a linked or swapped nested source directory", async () => {
    await mkdir(path.join(root, "sources", "nested"), { recursive: true });
    await writeFile(path.join(root, "sources", "nested", "a.md"), sourceText("A", "manual:a"));
    await writeFile(path.join(outside, "a.md"), sourceText("SECRET", "manual:secret"));
    await symlink(outside, path.join(root, "sources", "linked"));
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki", "config.json"), JSON.stringify({ version: 1, sources: { recursive: true } }));
    await activateIndexed(root);
    expect((await routedListSources(root)).sources.map((source) => source.id)).toEqual(["nested/a.md"]);
    await rename(path.join(root, "sources", "nested"), path.join(root, "nested-moved"));
    await symlink(outside, path.join(root, "sources", "nested"));
    const listed = await routedListSources(root, { includeBody: true });
    expect(JSON.stringify(listed)).not.toContain("SECRET");
    expect(listed.catalog).toMatchObject({ staleRows: { count: 1 } });
  });
});

describe("profiles", () => {
  it("refuses a profile change and an indexed listing under a non-default profile", async () => {
    await writeCorpus(root, 2, 0);
    await activateIndexed(root);
    await expect(assertProfileChangeAllowed(root)).rejects.toMatchObject({ block: "scale-profile-ineligible" });
    await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify({ profileId: "custom", version: 1 }));
    await expect(routedListPages(root)).rejects.toMatchObject({ block: "scale-profile-ineligible" });
  });
});
