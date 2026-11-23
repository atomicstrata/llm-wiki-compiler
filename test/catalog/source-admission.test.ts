/**
 * @file test/catalog/source-admission.test.ts
 * @description Indexed source admission must preserve authoritative bytes and
 * identity when the catalog cannot represent a document. These offline real-
 * disk fixtures use the real gated save; activation is the catalog fixture's
 * shortcut, not proof of full scale preparation. No clock or environment is
 * changed. Large strings exist only inside the selected test's owned TMPDIR.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { restoreGlobals, stubGlobal } from "../stubs.js";
import { catalogSync } from "../../src/catalog/facade.js";
import { catalogMetaOf, openCatalog } from "../../src/catalog/meta.js";
import { saveSourceUnderProjectGate } from "../../src/operation-bundles/registered-project-lock.js";
import { activateIndexed, writeCorpus } from "./helpers.js";

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const IDENTITY = "manual:admission";
const HEADER = `---\ntitle: Admission\nsource: ${IDENTITY}\nsourceType: file\n---\n\n`;
let root: string;

/** Create a private empty ready indexed fixture; no provider is constructed. */
async function setupFixture(): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), "llmwiki-catalog-admission-"));
  stubGlobal("fetch", () => { throw new Error("network forbidden in catalog admission tests"); });
  await writeCorpus(root, 0, 0);
  await activateIndexed(root);
  expect(catalogMetaOf(await openCatalog(root)).phase).toBe("ready");
}

/** Restore the throwing fetch seam and delete only this test's owned root. */
async function cleanupFixture(): Promise<void> {
  restoreGlobals();
  await rm(root, { recursive: true, force: true });
}

beforeEach(setupFixture);
afterEach(cleanupFixture);

/** Build valid Markdown with exactly `bytes` UTF-8 bytes, optionally multibyte. */
function documentOfBytes(bytes: number, multibyte = false): string {
  const remaining = bytes - Buffer.byteLength(HEADER, "utf8");
  const body = multibyte ? "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2) : "a".repeat(remaining);
  return HEADER + body;
}

/** Capture all authoritative source contents by digest and exact catalog fence. */
async function snapshot(): Promise<{ sources: Array<[string, string]>; manifest: Buffer }> {
  const sources: Array<[string, string]> = [];
  for (const name of (await readdir(path.join(root, "sources"))).sort()) {
    const bytes = await readFile(path.join(root, "sources", name));
    sources.push([name, createHash("sha256").update(bytes).digest("hex")]);
  }
  return { sources, manifest: await readFile(path.join(root, ".llmwiki", "indexed", "catalog", "manifest.json")) };
}

/** Save through the real registered project's mutation gate and catalog route. */
function save(document: string): ReturnType<typeof saveSourceUnderProjectGate> {
  return saveSourceUnderProjectGate(root, "Admission", document, IDENTITY);
}

/** Require the precise operator refusal and no authoritative/catalog mutation. */
async function expectRefusal(document: string, code: "catalog_source_too_large" | "catalog_source_identity_unavailable"): Promise<void> {
  const before = await snapshot();
  const action = code === "catalog_source_too_large" ? "reduce the source" : "reconcile or repair";
  await expect(save(document)).rejects.toMatchObject({ code, message: expect.stringContaining(action) });
  expect(await snapshot()).toEqual(before);
}

describe("indexed catalog source admission", () => {
  /** The first RED must be the missing specific refusal, not a setup fault. */
  it("refuses a 16 MiB plus one byte document before source publication", async () => {
    const document = documentOfBytes(MAX_DOCUMENT_BYTES + 1);
    expect(Buffer.byteLength(document, "utf8")).toBe(MAX_DOCUMENT_BYTES + 1);
    await expectRefusal(document, "catalog_source_too_large");
  });

  /** Inclusive byte boundary remains usable and identity-idempotent. */
  it("accepts exactly 16 MiB and reuses the same source identity unchanged", async () => {
    const document = documentOfBytes(MAX_DOCUMENT_BYTES);
    expect(Buffer.byteLength(document, "utf8")).toBe(MAX_DOCUMENT_BYTES);
    const first = await save(document);
    const before = await snapshot();
    const second = await save(document);
    expect([first.writeStatus, second.writeStatus, second.path]).toEqual(["created", "unchanged", first.path]);
    expect(await readFile(first.path, "utf8")).toBe(document);
    expect(catalogMetaOf(await openCatalog(root)).counts.sources).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  /** A character-count check must not stand in for the UTF-8 byte limit. */
  it("refuses multibyte UTF-8 above the byte cap despite fewer characters", async () => {
    const document = documentOfBytes(MAX_DOCUMENT_BYTES + 1, true);
    expect(document.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    expect(Buffer.byteLength(document, "utf8")).toBe(MAX_DOCUMENT_BYTES + 1);
    await expectRefusal(document, "catalog_source_too_large");
  });

  /** Explicit reconciliation makes existing omitted inventory visible as debt. */
  it("refuses negative identity proof after sync finds oversized inventory", async () => {
    await writeFile(path.join(root, "sources", "oversized.md"), documentOfBytes(MAX_DOCUMENT_BYTES + 1));
    await catalogSync(root);
    expect(catalogMetaOf(await openCatalog(root)).uncatalogued.count).toBe(1);
    await expectRefusal(documentOfBytes(1024), "catalog_source_identity_unavailable");
  });

  /** An existing identity whose candidate grew unreadable must not fork. */
  it("refuses an unreadable indexed identity candidate rather than a new name", async () => {
    const saved = await save(documentOfBytes(1024));
    expect(saved.writeStatus).toBe("created");
    await writeFile(saved.path, documentOfBytes(MAX_DOCUMENT_BYTES + 1));
    expect(catalogMetaOf(await openCatalog(root)).uncatalogued.count).toBe(0);
    await expectRefusal(documentOfBytes(1024), "catalog_source_identity_unavailable");
  });
});
