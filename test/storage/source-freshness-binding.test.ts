/**
 * @file test/storage/source-freshness-binding.test.ts
 * @description Source freshness over its sources. This file uses
 * `buildFreshnessSnapshotFrom`, which exists only after freshness was given a
 * capability to read through, so it has NO before-edit run and is not part of
 * `source-freshness-legacy.test.ts`.
 *
 * There is no project directory. The sources are an in-memory double that
 * holds text by key and decides nothing: it answers where a key is (a token,
 * or `null`), and serves or refuses the text behind a token. The production
 * body runs on what it serves: the `ok` gate, the state's key order, one source
 * at a time, the "not there" result, the SHA-256 of the served text, and the
 * absence of any catch.
 *
 * NOT SHOWN HERE: how the local disk decides where a source is. The lexical
 * test, the existence test and the inside-the-real-sources-root test live in
 * the disk implementation and are exercised only by the disk tests
 * (`freshness.test.ts`, `residual-reads.test.ts`,
 * `source-freshness-legacy.test.ts`).
 *
 * The double is a test double. It is not a hosted store, not an access-control
 * layer and not `ProjectStore`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { buildFreshnessSnapshotFrom, type SourceFreshnessSources, type SourceLocations } from "../../src/freshness/index.js";
import type { ClassifiedState, StateStatus } from "../../src/utils/state.js";

/** SHA-256 of the text "A text", written out so the algorithm is pinned without any helper. */
const A_TEXT_HASH = "d0fc7c50a7a43386792a02f0b10da96fde409b0c312f3737777be4cc691bb631";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Sources held in memory: a key maps to its text, or to an `Error` its read rejects with. A key not held cannot be placed. */
function memorySources(held: Record<string, string | Error>) {
  const log: string[] = [];
  const locations: SourceLocations = {
    resolveSource: async (file) => { log.push(`resolve ${file}`); return file in held ? `mem:${file}` : null; },
    readText: async (token) => {
      log.push(`read ${token}`);
      const text = held[token.slice("mem:".length)]!;
      if (text instanceof Error) throw text;
      return text;
    },
  };
  const sources: SourceFreshnessSources = { openSources: async () => { log.push("open"); return locations; } };
  return { sources, log };
}

/** A classified state listing `entries` in the order given. */
function classified(status: StateStatus, entries: Record<string, { hash: string; concepts: string[] }>): ClassifiedState {
  const sources = Object.fromEntries(Object.entries(entries).map(([file, entry]) => [file, { ...entry, compiledAt: "t" }]));
  return { status, state: { version: 1, indexHash: "", sources } };
}

describe("source freshness over its sources", () => {
  it("M1 opens once, then resolves, reads and hashes each source in the state's key order", async () => {
    const { sources, log } = memorySources({ "b.md": "B text", "a.md": "A text" });
    const state = classified("ok", { "b.md": { hash: sha("B text"), concepts: ["one"] }, "a.md": { hash: "OLD", concepts: ["two"] } });
    const built = await buildFreshnessSnapshotFrom(sources, state);
    expect(built).toEqual({ stateStatus: "ok", sources: {
      "b.md": { recordedHash: sha("B text"), currentHash: sha("B text"), exists: true, concepts: ["one"] },
      "a.md": { recordedHash: "OLD", currentHash: A_TEXT_HASH, exists: true, concepts: ["two"] },
    } });
    expect(Object.keys(built.sources)).toEqual(["b.md", "a.md"]);
    expect(log).toEqual(["open", "resolve b.md", "read mem:b.md", "resolve a.md", "read mem:a.md"]);
  });

  it.each(["missing", "corrupt", "too-new"] as const)("M2 makes no source call at all for a %s state", async (status) => {
    const { sources, log } = memorySources({ "a.md": "A text" });
    const built = await buildFreshnessSnapshotFrom(sources, classified(status, { "a.md": { hash: "OLD", concepts: ["two"] } }));
    expect(built).toEqual({ stateStatus: status, sources: {} });
    expect(log).toEqual([]);
  });

  it("M3 answers not-there for a source that cannot be placed, and never reads it", async () => {
    const { sources, log } = memorySources({ "here.md": "A text" });
    const state = classified("ok", { "gone.md": { hash: "G", concepts: ["ghost"] }, "here.md": { hash: A_TEXT_HASH, concepts: ["live"] } });
    expect((await buildFreshnessSnapshotFrom(sources, state)).sources).toEqual({
      "gone.md": { recordedHash: "G", currentHash: null, exists: false, concepts: ["ghost"] },
      "here.md": { recordedHash: A_TEXT_HASH, currentHash: A_TEXT_HASH, exists: true, concepts: ["live"] },
    });
    expect(log).toEqual(["open", "resolve gone.md", "resolve here.md", "read mem:here.md"]);
  });

  it("M4 rejects with the read's own error object and touches no later source", async () => {
    const refused = Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
    const { sources, log } = memorySources({ "first.md": "1", "folder.md": refused, "after.md": "3" });
    const entry = { hash: "H", concepts: ["topic"] };
    const state = classified("ok", { "first.md": entry, "folder.md": entry, "after.md": entry });
    await expect(buildFreshnessSnapshotFrom(sources, state)).rejects.toBe(refused);
    expect(log).toEqual(["open", "resolve first.md", "read mem:first.md", "resolve folder.md", "read mem:folder.md"]);
  });
});
