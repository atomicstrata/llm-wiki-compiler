/**
 * @file test/pending-embeddings.test.ts
 * @description Unit + confinement coverage for the durable per-id pending-embedding
 * refresh marker (`src/utils/pending-embeddings.ts`) — persistence, schema
 * migration, caps, confinement, and write durability.
 *
 * Pins: absent-root reads return `[]` without creating `.llmwiki`; write replaces
 * (caller computes the full set) and deletes the file when emptied; a legacy flat
 * `string[]` marker migrates to `{pageId, attempts:0}`; an escaping `.llmwiki`
 * symlink makes load fail open and write never touches an out-of-tree victim; a
 * genuine I/O write failure surfaces a warning while an escaping leaf stays silent.
 * The per-id lifecycle (settle/quarantine) is covered in
 * `pending-embeddings-lifecycle.test.ts`.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdir, symlink, readFile, writeFile, readdir, chmod } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  LLMWIKI_DIR,
  PENDING_EMBEDDINGS_FILE,
  MAX_PENDING_EMBEDDINGS_BYTES,
  MAX_PENDING_EMBEDDING_IDS,
} from "../src/utils/constants.js";
import {
  loadPendingEmbeddings,
  writePendingEmbeddings,
  clearPendingEmbeddings,
  type PendingEmbedding,
} from "../src/utils/pending-embeddings.js";
import * as output from "../src/utils/output.js";
import {
  makeRootWithOutside,
  cleanupRootWithOutside,
} from "./trust/fixture.js";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  ({ root, outsideDir } = await makeRootWithOutside("pending-embed-"));
});

afterEach(async () => {
  await cleanupRootWithOutside({ root, outsideDir });
});

/** Absolute path to the pending-embeddings marker under `root/.llmwiki`. */
function markerPath(): string {
  return path.join(root, PENDING_EMBEDDINGS_FILE);
}

/** Build entries with attempts 0 from bare page-ids (test ergonomics). */
function fresh(...ids: string[]): PendingEmbedding[] {
  return ids.map((pageId) => ({ pageId, attempts: 0 }));
}

/** The loaded page-ids, dropping attempt counts for order/content assertions. */
async function loadedIds(): Promise<string[]> {
  return (await loadPendingEmbeddings(root)).map((e) => e.pageId);
}

describe("loadPendingEmbeddings", () => {
  it("returns [] on a root with no .llmwiki, without creating it (no-mkdir)", async () => {
    expect(await loadPendingEmbeddings(root)).toEqual([]);
    expect(existsSync(path.join(root, LLMWIKI_DIR))).toBe(false);
  });
});

describe("write then load", () => {
  it("round-trips entries with attempt counts", async () => {
    await writePendingEmbeddings(root, [
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 3 },
    ]);
    expect(await loadPendingEmbeddings(root)).toEqual([
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 3 },
    ]);
  });

  it("replaces the marker (caller computes the full set, not a union)", async () => {
    await writePendingEmbeddings(root, fresh("concepts/a", "concepts/b"));
    await writePendingEmbeddings(root, fresh("concepts/c"));
    expect(await loadedIds()).toEqual(["concepts/c"]);
  });

  it("dedups by pageId keeping the max attempts seen", async () => {
    await writePendingEmbeddings(root, [
      { pageId: "concepts/a", attempts: 1 },
      { pageId: "concepts/a", attempts: 4 },
    ]);
    expect(await loadPendingEmbeddings(root)).toEqual([{ pageId: "concepts/a", attempts: 4 }]);
  });

  it("deletes the file when given an empty set", async () => {
    await writePendingEmbeddings(root, fresh("concepts/a"));
    await writePendingEmbeddings(root, []);
    expect(existsSync(markerPath())).toBe(false);
  });
});

describe("clearPendingEmbeddings", () => {
  it("deletes the marker entirely", async () => {
    await writePendingEmbeddings(root, fresh("concepts/a"));
    await clearPendingEmbeddings(root);
    expect(existsSync(markerPath())).toBe(false);
  });

  it("is a no-op no-throw when the marker is absent", async () => {
    await expect(clearPendingEmbeddings(root)).resolves.toBeUndefined();
    expect(existsSync(markerPath())).toBe(false);
  });
});

describe("backward-compat: legacy flat string[] marker", () => {
  it("loads a legacy string[] as entries with attempts:0 and round-trips", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(markerPath(), JSON.stringify(["concepts/a", "concepts/b"]), "utf-8");
    const loaded = await loadPendingEmbeddings(root);
    expect(loaded).toEqual([
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 0 },
    ]);
    await writePendingEmbeddings(root, loaded); // migrate on write
    const reloaded = JSON.parse(await readFile(markerPath(), "utf-8")) as unknown[];
    expect(reloaded).toEqual([
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 0 },
    ]);
  });

  it("migrates a mixed marker (bare string + object entries)", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(
      markerPath(),
      JSON.stringify(["concepts/legacy", { pageId: "concepts/new", attempts: 2 }]),
      "utf-8",
    );
    expect(await loadPendingEmbeddings(root)).toEqual([
      { pageId: "concepts/legacy", attempts: 0 },
      { pageId: "concepts/new", attempts: 2 },
    ]);
  });
});

describe("confinement: escaping .llmwiki symlink", () => {
  /** Plant `root/.llmwiki` as a symlink to the out-of-tree victim dir. */
  async function plantPrivateDirSymlink(): Promise<void> {
    await symlink(outsideDir, path.join(root, LLMWIKI_DIR), "dir");
  }

  it("load returns [] and write never writes outside the root", async () => {
    await plantPrivateDirSymlink();
    expect(await loadPendingEmbeddings(root)).toEqual([]);
    await writePendingEmbeddings(root, fresh("concepts/a"));
    expect(await readdir(outsideDir)).toEqual([]); // no marker leaked outside
  });

  it("clear never deletes an out-of-tree victim", async () => {
    const victim = path.join(outsideDir, path.basename(PENDING_EMBEDDINGS_FILE));
    await writeFile(victim, "[\"victim\"]", "utf-8");
    await plantPrivateDirSymlink();
    await clearPendingEmbeddings(root);
    expect(existsSync(victim)).toBe(true); // victim survives
  });
});

describe("corrupt marker", () => {
  it("load returns [] on unparseable JSON (no throw)", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(markerPath(), "{not json", "utf-8");
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  });
});

describe("confinement: symlinked marker LEAF (real .llmwiki dir)", () => {
  /** Path of an out-of-tree victim file the planted leaf symlink points at. */
  function victimPath(): string {
    return path.join(outsideDir, "victim-target.json");
  }

  /** Plant `root/.llmwiki/pending-embeddings.json` as a symlink to an out-of-tree victim. */
  async function plantLeafSymlink(victimBody: string): Promise<string> {
    const victim = victimPath();
    await writeFile(victim, victimBody, "utf-8");
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await symlink(victim, markerPath(), "file");
    return victim;
  }

  it("write never overwrites the out-of-tree victim through a symlinked leaf (no throw)", async () => {
    const victim = await plantLeafSymlink("[\"victim\"]");
    // The hardened confined atomicWrite fails closed instead of following the leaf
    // symlink — best-effort, so no throw; the escape is swallowed SILENTLY.
    const warnSpy = vi.spyOn(output, "status").mockImplementation(() => {});
    await expect(writePendingEmbeddings(root, fresh("concepts/leak"))).resolves.toBeUndefined();
    expect(await readFile(victim, "utf-8")).toBe("[\"victim\"]"); // victim never overwritten
    expect(warnSpy).not.toHaveBeenCalled(); // a fail-closed escape is NOT a durability warning
    warnSpy.mockRestore();
  });
});

describe("durability: genuine I/O write failure surfaces a warning", () => {
  // chmod 0o500 does NOT block writes when running as ROOT (some CI containers do),
  // which would silently FALSE-PASS this test — skip it there rather than give
  // false confidence.
  it.skipIf(process.getuid?.() === 0)("warns (not silent) when the .llmwiki dir is read-only so the write fails", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await chmod(path.join(root, LLMWIKI_DIR), 0o500); // read+execute, no write → EACCES on temp create
    const warnSpy = vi.spyOn(output, "status").mockImplementation(() => {});
    try {
      await expect(writePendingEmbeddings(root, fresh("concepts/a"))).resolves.toBeUndefined();
      const warned = warnSpy.mock.calls.some(([, msg]) => /could not persist/i.test(String(msg)));
      expect(warned).toBe(true); // a genuine write failure is SURFACED, not swallowed
    } finally {
      warnSpy.mockRestore();
      await chmod(path.join(root, LLMWIKI_DIR), 0o700); // restore so afterEach can clean up
    }
  });
});

describe("write cap: marker can never exceed the reader's bounds", () => {
  /** Byte size of the on-disk marker file. */
  async function markerBytes(): Promise<number> {
    return Buffer.byteLength(await readFile(markerPath(), "utf-8"), "utf-8");
  }

  it("caps a write large enough to blow the byte cap so load stays non-empty", async () => {
    const entries = fresh(...Array.from({ length: 20000 }, (_, i) => `concepts/page${i}`));
    await writePendingEmbeddings(root, entries);
    expect(await markerBytes()).toBeLessThanOrEqual(MAX_PENDING_EMBEDDINGS_BYTES);
    expect((await loadPendingEmbeddings(root)).length).toBeGreaterThan(0);
  });

  it("bounds the loaded list to the id count cap on write", async () => {
    const entries = fresh(
      ...Array.from({ length: MAX_PENDING_EMBEDDING_IDS + 1000 }, (_, i) => `concepts/p${i}`),
    );
    await writePendingEmbeddings(root, entries);
    expect((await loadPendingEmbeddings(root)).length).toBeLessThanOrEqual(MAX_PENDING_EMBEDDING_IDS);
  });

  it("drops the tail when long ids would blow the byte cap even within the count cap", async () => {
    const entries = fresh(
      ...Array.from({ length: MAX_PENDING_EMBEDDING_IDS }, (_, i) => `concepts/${"p".repeat(60)}${i}`),
    );
    await writePendingEmbeddings(root, entries);
    expect(await markerBytes()).toBeLessThanOrEqual(MAX_PENDING_EMBEDDINGS_BYTES);
    const loaded = await loadPendingEmbeddings(root);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThan(MAX_PENDING_EMBEDDING_IDS);
  });
});

describe("load: size cap, no-follow, and id validation", () => {
  /** Write a real marker file under `root/.llmwiki`. */
  async function writeMarker(body: string): Promise<void> {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(markerPath(), body, "utf-8");
  }

  it("returns [] for an oversize marker (> cap) without slurping it", async () => {
    const filler = "concepts/" + "x".repeat(MAX_PENDING_EMBEDDINGS_BYTES);
    await writeMarker(JSON.stringify([filler]));
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  });

  it("returns [] for a symlinked marker leaf (no-follow)", async () => {
    const victim = path.join(outsideDir, "huge.json");
    await writeFile(victim, JSON.stringify(["concepts/a"]), "utf-8");
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await symlink(victim, markerPath(), "file");
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  });

  it("drops non-PageId entries, keeping valid ids", async () => {
    await writeMarker(JSON.stringify(["concepts/keep", "../../etc", "not a pageid", "queries/ok"]));
    expect(await loadedIds()).toEqual(["concepts/keep", "queries/ok"]);
  });

  it("truncates an over-count marker to the id cap", async () => {
    const ids = Array.from({ length: MAX_PENDING_EMBEDDING_IDS + 50 }, (_, i) => `concepts/p${i}`);
    await writeMarker(JSON.stringify(ids));
    expect(await loadPendingEmbeddings(root)).toHaveLength(MAX_PENDING_EMBEDDING_IDS);
  });
});
