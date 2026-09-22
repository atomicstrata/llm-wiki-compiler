/**
 * @file test/operations-packs/store-snapshot.test.ts
 * @description The reconcile snapshot's park-vs-deny classification, unit-tested
 * at the module that owns it: an unreadable profile or an invalid page REFUSES
 * ("couldn't read" is never "no pages"), an UNDECLARED compared class REFUSES
 * (a vacuously-empty snapshot would classify a real collision absent), the one
 * truthful empty snapshot is a DECLARED type with zero pages, and a valid page
 * projects to a slug-keyed item carrying exactly its scalar frontmatter — the
 * identity/field shape the reconcile handler compares. The list-valued
 * frontmatter case pins the deterministic non-scalar OMISSION, so a page with
 * tags never round-trips differently between runs.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packStoreSnapshot, CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../../src/operations-packs/runtime/store-snapshot.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A fresh project root, tracked for cleanup. */
async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "g2-snapshot-"));
  roots.push(root);
  return root;
}

/** Install a profile declaring `wiki-page`, optionally with a required field. */
async function installProfile(root: string, requiredFields?: string[]): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  const fields = Object.fromEntries((requiredFields ?? []).map((field) => [field, { type: "string" }]));
  await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify({
    schemaVersion: 1, profileId: "g2-test", displayName: "G2",
    entities: {
      "wiki-page": {
        directory: "wiki/wiki-page",
        ...(requiredFields ? { requiredFields, fields } : {}),
      },
    },
  }), "utf8");
}

/** Write one page under the declared entity directory. */
async function writePage(root: string, frontmatter: string): Promise<void> {
  const dir = path.join(root, "wiki", "wiki-page");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "existing.md"), `---\n${frontmatter}\n---\n\nBody.\n`, "utf8");
}

describe("packStoreSnapshot park-vs-deny classification", () => {
  it("projects a valid page to a slug-keyed item of its SCALAR frontmatter", async () => {
    const root = await projectRoot();
    await installProfile(root);
    await writePage(root, "topic: x\nversion: 2\ntags:\n  - a\n  - b");
    const snapshot = await packStoreSnapshot(root, "wiki-page");
    if (snapshot.kind !== "ok") throw new Error(JSON.stringify(snapshot));
    const [item] = snapshot.items;
    expect(item?.itemId).toBe("existing");
    // List frontmatter is still dropped; the scalars are still exactly these.
    expect(item?.fields.topic).toBe("x");
    expect(item?.fields.version).toBe(2);
    expect(item?.fields.tags).toBeUndefined();
    // Plus the ON-DISK identity an authored update needs as its precondition.
    // Reconcile strips these before comparing, so they cannot affect a verdict.
    expect(item?.fields[CURRENT_DIGEST_FIELD]).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.fields[CURRENT_BYTES_FIELD]).toBeGreaterThan(0);
  });

  it("is truthfully empty ONLY for a declared type with zero pages", async () => {
    const root = await projectRoot();
    await installProfile(root);
    expect(await packStoreSnapshot(root, "wiki-page")).toEqual({ kind: "ok", items: [] });
  });

  it("REFUSES an UNDECLARED compared class instead of reporting it empty", async () => {
    // A vacuously-empty snapshot would classify a real collision `absent`.
    const root = await projectRoot();
    await installProfile(root);
    expect((await packStoreSnapshot(root, "nonexistent")).kind).toBe("refused");
  });

  it("REFUSES on the built-in default profile rather than comparing against nothing", async () => {
    expect((await packStoreSnapshot(await projectRoot(), "concepts")).kind).toBe("refused");
  });

  it("REFUSES when the profile file is unreadable", async () => {
    // Companion to the drive suite's unreadable-profile case: SAME corrupt
    // bytes, so this pins WHICH refusal fires where the drive can only observe
    // phase states (PhaseSummaryV1 records no problem code).
    const root = await projectRoot();
    await installProfile(root);
    await writeFile(path.join(root, ".llmwiki", "profile.json"), "not json {{{", "utf8");
    const snapshot = await packStoreSnapshot(root, "wiki-page");
    expect(snapshot.kind).toBe("refused");
  });

  it("REFUSES when any page fails collection, rather than omitting it as absent", async () => {
    const root = await projectRoot();
    await installProfile(root, ["topic"]);
    await writePage(root, "unrelated: y");
    const snapshot = await packStoreSnapshot(root, "wiki-page");
    expect(snapshot.kind).toBe("refused");
  });

  it("REFUSES when a page file silently vanishes from the scan (symlinked leaf)", async () => {
    // The scan DROPS an unresolvable leaf without a problem; the .md entry
    // count disagreeing with the scan is the witness. Reporting the page
    // absent would be the false answer a collision check must never give.
    const root = await projectRoot();
    await installProfile(root);
    await writePage(root, "topic: x");
    await symlink(path.join(root, "nonexistent.md"), path.join(root, "wiki", "wiki-page", "broken.md"));
    expect((await packStoreSnapshot(root, "wiki-page")).kind).toBe("refused");
  });

  it("REFUSES a page with malformed frontmatter instead of comparing it as blank", async () => {
    const root = await projectRoot();
    await installProfile(root);
    await writePage(root, "topic: [unclosed");
    expect((await packStoreSnapshot(root, "wiki-page")).kind).toBe("refused");
  });

  it("drops a non-finite number deterministically instead of throwing downstream", async () => {
    const root = await projectRoot();
    await installProfile(root);
    await writePage(root, "topic: x\nweight: .inf");
    const snapshot = await packStoreSnapshot(root, "wiki-page");
    if (snapshot.kind !== "ok") throw new Error(JSON.stringify(snapshot));
    // The non-finite value is gone; the finite scalar and the on-disk identity
    // remain. Asserting the FRONTMATTER keys specifically, so the reserved
    // fields cannot mask a frontmatter scalar that should have been dropped.
    expect(snapshot.items[0]?.fields.weight).toBeUndefined();
    expect(snapshot.items[0]?.fields.topic).toBe("x");
  });
});
