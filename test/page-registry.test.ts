/**
 * Tests for the live page registry: metadata-only id-set, lazy confined entry
 * with live hashes, and the confined-read loaders.
 *
 * Security invariant: the loaders NEVER read out-of-tree. Absent, forged, and
 * symlinked-escaping pageIds are all dropped before any bytes are read.
 *
 * Namespace resolution: typed entity namespaces resolve via the profile's
 * `entities[type].directory` (not a hardcoded `wiki/<namespace>`). Unknown
 * namespaces are dropped — never fall through to `wiki/<namespace>`.
 *
 * Eligibility parity: `buildLiveIdSet` applies the SAME embed-eligibility predicate
 * as the writer so orphaned/untitled/profile-invalid pages cannot resurrect from a
 * stale or forged v3 store (the prefilter drops their store entries).
 */

import { describe, it, expect } from "vitest";
import { writeFile, symlink } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { writePage } from "./fixtures/write-page.js";
import { splitIntoChunks, hashChunkText } from "../src/utils/retrieval.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import {
  buildLiveIdSet,
  buildLiveRegistryEntry,
  buildNamespaceDirs,
  loadPageRecordsByPageId,
  loadSelectedPagesByPageId,
} from "../src/utils/page-registry.js";
import type { ProfilePack, LoadedProfile } from "../src/profile/types.js";

// ---------------------------------------------------------------------------
// buildLiveIdSet — metadata-only (no body read)
// ---------------------------------------------------------------------------

describe("buildLiveIdSet", () => {
  it("returns qualified PageIds for concepts and queries without reading bodies", async () => {
    const root = await makeTempRoot("registry-ids");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "s" }, "body text");
    await writePage(path.join(root, "wiki/queries"), "beta", { title: "Beta", summary: "s" }, "body text");
    const ids = await buildLiveIdSet(root, ["concepts", "queries"]);
    expect(ids.has("concepts/alpha")).toBe(true);
    expect(ids.has("queries/beta")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("scans only the requested namespaces", async () => {
    const root = await makeTempRoot("registry-ids-ns");
    await writePage(path.join(root, "wiki/concepts"), "gamma", { title: "G", summary: "" }, "body");
    await writePage(path.join(root, "wiki/queries"), "delta", { title: "D", summary: "" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/gamma")).toBe(true);
    expect(ids.has("queries/delta")).toBe(false);
  });

  it("returns empty set when namespace directory is absent", async () => {
    const root = await makeTempRoot("registry-ids-empty");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildLiveRegistryEntry — lazy confined entry with live hashes
// ---------------------------------------------------------------------------

describe("buildLiveRegistryEntry", () => {
  it("returns entry with correct embeddingTextHash and chunkHashes for a real page", async () => {
    const root = await makeTempRoot("registry-entry");
    const body = "First paragraph.\n\nSecond paragraph.";
    await writePage(path.join(root, "wiki/concepts"), "mypage", { title: "My Page", summary: "A summary" }, body);
    const entry = await buildLiveRegistryEntry(root, "concepts/mypage");
    expect(entry).not.toBeNull();
    const expectedEmbText = buildEmbeddingText({ title: "My Page", summary: "A summary" });
    expect(entry!.embeddingTextHash).toBe(hashChunkText(expectedEmbText));
    const chunks = splitIntoChunks(body);
    expect(entry!.chunkHashes).toEqual(chunks.map(hashChunkText));
  });

  it("returns null for a non-live pageId", async () => {
    const root = await makeTempRoot("registry-entry-absent");
    const entry = await buildLiveRegistryEntry(root, "concepts/nonexistent");
    expect(entry).toBeNull();
  });

  it("drops a symlink-escaping page (returns null)", async () => {
    const root = await makeTempRoot("registry-entry-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "secret.md"), "---\ntitle: Evil\nsummary: s\n---\n\nevil body");
    const conceptsDir = path.join(root, "wiki/concepts");
    await symlink(path.join(outside, "secret.md"), path.join(conceptsDir, "secret.md"));
    const entry = await buildLiveRegistryEntry(root, "concepts/secret");
    expect(entry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadPageRecordsByPageId — confined read, drops absent/forged/escaping ids
// ---------------------------------------------------------------------------

describe("loadPageRecordsByPageId", () => {
  it("resolves a live pageId to its content via confined read", async () => {
    const root = await makeTempRoot("load-by-id");
    await writePage(path.join(root, "wiki/concepts"), "mypage", { title: "My Page", summary: "sum" }, "hello body");
    const records = await loadPageRecordsByPageId(root, ["concepts/mypage"]);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("My Page");
  });

  it("drops an absent pageId without error", async () => {
    const root = await makeTempRoot("load-absent");
    const records = await loadPageRecordsByPageId(root, ["papers/deleted"]);
    expect(records).toHaveLength(0);
  });

  it("drops a forged path-traversal id without reading out-of-tree", async () => {
    const root = await makeTempRoot("load-forged");
    // "../../etc/passwd" fails parseQualifiedPageId (dangerous chars)
    const records = await loadPageRecordsByPageId(root, ["../../etc/passwd"]);
    expect(records).toHaveLength(0);
  });

  it("drops a symlink-escaping page and never reads out-of-tree", async () => {
    const root = await makeTempRoot("load-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "evil.md"), "---\ntitle: Evil\nsummary: s\n---\n\nevil");
    const conceptsDir = path.join(root, "wiki/concepts");
    await symlink(path.join(outside, "evil.md"), path.join(conceptsDir, "evil.md"));
    const records = await loadPageRecordsByPageId(root, ["concepts/evil"]);
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSelectedPagesByPageId — same security surface as loadPageRecordsByPageId
// ---------------------------------------------------------------------------

describe("loadSelectedPagesByPageId", () => {
  it("resolves multiple live pageIds and returns their records", async () => {
    const root = await makeTempRoot("load-selected");
    await writePage(path.join(root, "wiki/concepts"), "a", { title: "A", summary: "sa" }, "body a");
    await writePage(path.join(root, "wiki/queries"), "b", { title: "B", summary: "sb" }, "body b");
    const records = await loadSelectedPagesByPageId(root, ["concepts/a", "queries/b"]);
    expect(records.map((r) => r.title).sort()).toEqual(["A", "B"]);
  });

  it("drops absent and invalid refs silently", async () => {
    const root = await makeTempRoot("load-selected-drop");
    await writePage(path.join(root, "wiki/concepts"), "real", { title: "Real", summary: "" }, "body");
    const records = await loadSelectedPagesByPageId(root, ["concepts/real", "concepts/ghost", "../../bad"]);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Real");
  });
});

// ---------------------------------------------------------------------------
// buildNamespaceDirs — typed entity directory resolution (the hardcode fix)
// ---------------------------------------------------------------------------

/** Minimal profile with `papers` at a standard dir and `research` at a custom dir. */
function typedProfile(papersDir: string): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "test",
    entities: {
      papers: { directory: papersDir },
      ideas: { directory: "wiki/ideas" },
    },
  };
}

describe("buildNamespaceDirs — typed namespace resolution", () => {
  it("resolves a typed namespace to the profile entity directory (not wiki/<namespace>)", () => {
    const dirs = buildNamespaceDirs(typedProfile("wiki/research-papers"));
    expect(dirs.get("papers")).toBe("wiki/research-papers");
  });

  it("resolves concepts/queries to reserved dirs regardless of profile", () => {
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    expect(dirs.get("concepts")).toBe("wiki/concepts");
    expect(dirs.get("queries")).toBe("wiki/queries");
  });

  it("returns undefined for an unknown namespace (does NOT fall back to wiki/<ns>)", () => {
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    expect(dirs.get("unknown-ns")).toBeUndefined();
  });

  it("defaults to only reserved namespaces when no profile is supplied", () => {
    const dirs = buildNamespaceDirs();
    expect(dirs.get("concepts")).toBe("wiki/concepts");
    expect(dirs.get("queries")).toBe("wiki/queries");
    expect(dirs.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Typed entity page resolution end-to-end
// ---------------------------------------------------------------------------

describe("typed namespace — end-to-end page resolution", () => {
  it("resolves papers/foo via wiki/papers when profile.entities.papers.directory = wiki/papers", async () => {
    const root = await makeTempRoot("typed-standard-dir");
    const { mkdir } = await import("fs/promises");
    const papersDir = path.join(root, "wiki/papers");
    await mkdir(papersDir, { recursive: true });
    await writePage(papersDir, "foo", { title: "Foo Paper", summary: "s" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    const records = await loadPageRecordsByPageId(root, ["papers/foo"], dirs);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Foo Paper");
  });

  it("resolves papers/foo via a CUSTOM directory (not wiki/papers), proving hardcode is gone", async () => {
    const root = await makeTempRoot("typed-custom-dir");
    const { mkdir } = await import("fs/promises");
    const customDir = path.join(root, "wiki/research-papers");
    await mkdir(customDir, { recursive: true });
    await writePage(customDir, "foo", { title: "Custom Dir Paper", summary: "s" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/research-papers"));
    const records = await loadPageRecordsByPageId(root, ["papers/foo"], dirs);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Custom Dir Paper");
  });

  it("does NOT resolve papers/foo from wiki/papers when profile.directory = wiki/research-papers", async () => {
    const root = await makeTempRoot("typed-wrong-dir");
    const { mkdir } = await import("fs/promises");
    // Page at wiki/papers (wrong dir per profile) — must NOT be found
    const wrongDir = path.join(root, "wiki/papers");
    await mkdir(wrongDir, { recursive: true });
    await writePage(wrongDir, "foo", { title: "Wrong Dir", summary: "s" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/research-papers"));
    const records = await loadPageRecordsByPageId(root, ["papers/foo"], dirs);
    expect(records).toHaveLength(0);
  });

  it("drops a typed page for an unknown namespace (not reserved, not in profile)", async () => {
    const root = await makeTempRoot("typed-unknown-ns");
    const { mkdir } = await import("fs/promises");
    // Even if wiki/unknowntype/foo.md exists, it must not be read
    const unknownDir = path.join(root, "wiki/unknowntype");
    await mkdir(unknownDir, { recursive: true });
    await writePage(unknownDir, "foo", { title: "Should Not Load", summary: "" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    const records = await loadPageRecordsByPageId(root, ["unknowntype/foo"], dirs);
    expect(records).toHaveLength(0);
  });

  it("concepts/queries still work when a profile is loaded", async () => {
    const root = await makeTempRoot("typed-reserved-regression");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    const records = await loadPageRecordsByPageId(root, ["concepts/alpha"], dirs);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("Alpha");
  });

  it("drops a symlink-escaping typed page (B2 confinement applies to custom dir)", async () => {
    const root = await makeTempRoot("typed-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "evil.md"), "---\ntitle: Evil\nsummary: s\n---\n\nevil");
    const { mkdir } = await import("fs/promises");
    const papersDir = path.join(root, "wiki/papers");
    await mkdir(papersDir, { recursive: true });
    await symlink(path.join(outside, "evil.md"), path.join(papersDir, "evil.md"));
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    const records = await loadPageRecordsByPageId(root, ["papers/evil"], dirs);
    expect(records).toHaveLength(0);
  });

  it("buildLiveRegistryEntry returns null for an unknown typed namespace", async () => {
    const root = await makeTempRoot("registry-typed-unknown");
    const dirs = buildNamespaceDirs(typedProfile("wiki/papers"));
    const entry = await buildLiveRegistryEntry(root, "unknowntype/foo", dirs);
    expect(entry).toBeNull();
  });

  it("buildLiveIdSet finds typed pages via the profile entity directory", async () => {
    const root = await makeTempRoot("ids-typed");
    const { mkdir } = await import("fs/promises");
    const customDir = path.join(root, "wiki/research-papers");
    await mkdir(customDir, { recursive: true });
    await writePage(customDir, "bar", { title: "Bar", summary: "" }, "body");
    const dirs = buildNamespaceDirs(typedProfile("wiki/research-papers"));
    const ids = await buildLiveIdSet(root, ["papers", "concepts"], dirs);
    expect(ids.has("papers/bar")).toBe(true);
    expect(ids.has("concepts/bar")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildLiveIdSet — embed-eligibility parity with the writer (F2)
// ---------------------------------------------------------------------------

/** Minimal LoadedProfile wrapping a given ProfilePack. */
function loadedProfile(pack: ProfilePack): LoadedProfile {
  return { profile: pack, loadedFrom: null, digest: "" };
}

/** Profile with a `notes` entity type at wiki/notes, optional retrieval. */
function notesProfile(retrieval?: Record<string, unknown>): LoadedProfile {
  return loadedProfile({
    schemaVersion: 1, profileId: "test",
    entities: { notes: { directory: "wiki/notes", ...(retrieval ? { retrieval } : {}) } },
  });
}

describe("buildLiveIdSet — eligibility parity with the writer", () => {
  it("excludes an orphaned concept (meta.orphaned:true) — matches writer which never embeds it", async () => {
    const root = await makeTempRoot("elig-orphaned");
    await writePage(path.join(root, "wiki/concepts"), "ghost", { title: "Ghost", orphaned: true }, "body");
    await writePage(path.join(root, "wiki/concepts"), "live", { title: "Live" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/ghost")).toBe(false);
    expect(ids.has("concepts/live")).toBe(true);
  });

  it("excludes an untitled concept — matches writer which never embeds it", async () => {
    const root = await makeTempRoot("elig-untitled");
    await writePage(path.join(root, "wiki/concepts"), "no-title", { summary: "s" }, "body");
    await writePage(path.join(root, "wiki/concepts"), "titled", { title: "Titled" }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/no-title")).toBe(false);
    expect(ids.has("concepts/titled")).toBe(true);
  });

  it("excludes a profile-invalid typed page (missing required field) from the live-id set", async () => {
    const root = await makeTempRoot("elig-invalid-typed");
    const { mkdir } = await import("fs/promises");
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    // field-violation: notes requires title field (profile declares it required)
    const profile: LoadedProfile = loadedProfile({
      schemaVersion: 1, profileId: "test",
      entities: { notes: { directory: "wiki/notes", requiredFields: ["title"], fields: { title: { type: "string" } } } },
    });
    await writePage(path.join(root, "wiki/notes"), "invalid-note", {}, "body"); // no title → field-violation
    await writePage(path.join(root, "wiki/notes"), "valid-note", { title: "Valid" }, "body");
    const dirs = buildNamespaceDirs(profile.profile);
    const ids = await buildLiveIdSet(root, ["notes"], dirs, profile);
    expect(ids.has("notes/invalid-note")).toBe(false);
    expect(ids.has("notes/valid-note")).toBe(true);
  });

  it("includes a typed page with includeInSearch:false (surface filter handles it, not the live-id set)", async () => {
    const root = await makeTempRoot("elig-search-false");
    const { mkdir } = await import("fs/promises");
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    // includeInSearch:false but includeInContext defaults to true → embedded:true
    const profile = notesProfile({ includeInSearch: false });
    await writePage(path.join(root, "wiki/notes"), "context-only", { title: "Context Only" }, "body");
    const dirs = buildNamespaceDirs(profile.profile);
    const ids = await buildLiveIdSet(root, ["notes"], dirs, profile);
    // Page IS in live-id set (it's embedded); surface filter in passesPrefilter handles search exclusion
    expect(ids.has("notes/context-only")).toBe(true);
  });

  it("excludes a typed page whose retrieval is both-surfaces false (embedded:false)", async () => {
    const root = await makeTempRoot("elig-both-false");
    const { mkdir } = await import("fs/promises");
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    const profile = notesProfile({ includeInSearch: false, includeInContext: false });
    await writePage(path.join(root, "wiki/notes"), "neither", { title: "Neither" }, "body");
    const dirs = buildNamespaceDirs(profile.profile);
    const ids = await buildLiveIdSet(root, ["notes"], dirs, profile);
    expect(ids.has("notes/neither")).toBe(false);
  });

  it("regression: eligible concepts/queries are present; ineligible (orphaned) are absent — gate is applied", async () => {
    const root = await makeTempRoot("elig-regression-default");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "sum" }, "body");
    // An orphaned concept in the same namespace — the eligibility gate must exclude it
    await writePage(path.join(root, "wiki/concepts"), "dead", { title: "Dead", orphaned: true }, "body");
    const ids = await buildLiveIdSet(root, ["concepts"]);
    expect(ids.has("concepts/alpha")).toBe(true);
    expect(ids.has("concepts/dead")).toBe(false);
    expect(ids.size).toBe(1);
  });
});
