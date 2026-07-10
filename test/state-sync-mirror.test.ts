/**
 * Tests for the v2 typed-mirror re-derivation at the writeState choke point.
 *
 * Phase 3 wires {@link syncEntityMirror} into {@link writeState} so that every
 * persisted v2 state has `entities` / `frozenEntities` re-derived from the v1
 * `concepts` / `frozenSlugs` lists — no writer can leave the mirror stale. The
 * key parity guarantee is pinned here too: writing a v1 (default-profile) state
 * is BYTE-IDENTICAL to before, with no typed-mirror keys added.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { writeState, syncEntityMirror } from "../src/utils/state.js";
import { STATE_FILE } from "../src/utils/constants.js";
import type { WikiState } from "../src/utils/types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "state-sync-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read and parse the persisted state.json. */
async function readPersisted(): Promise<WikiState> {
  return JSON.parse(await readFile(path.join(root, STATE_FILE), "utf-8"));
}

/** A v2 state whose typed mirror is intentionally stale/missing. */
function staleV2(): WikiState {
  return {
    version: 2,
    indexHash: "i",
    sources: { "a.md": { hash: "h", concepts: ["rag", "x"], compiledAt: "T" } },
    frozenSlugs: ["rag", "old"],
    frozenEntities: ["concepts/rag", "concepts/old", "concepts/stale"],
  };
}

describe("syncEntityMirror — v2 re-derivation", () => {
  it("re-derives source entities from the current concepts", () => {
    const synced = syncEntityMirror(staleV2());
    expect(synced.sources["a.md"].entities).toEqual(["concepts/rag", "concepts/x"]);
  });

  it("shrinks frozenEntities to match a smaller frozenSlugs (no stale entry)", () => {
    const state = staleV2();
    state.frozenSlugs = ["rag"];
    const synced = syncEntityMirror(state);
    expect(synced.frozenEntities).toEqual(["concepts/rag"]);
  });

  it("skips non-slug-safe (Unicode) concepts when re-deriving the mirror", () => {
    const state = staleV2();
    state.sources["a.md"].concepts = ["café-society", "rag"];
    const synced = syncEntityMirror(state);
    expect(synced.sources["a.md"].entities).toEqual(["concepts/rag"]);
  });

  it("returns a v1 state unchanged (strict no-op)", () => {
    const v1: WikiState = { version: 1, indexHash: "i", sources: {}, frozenSlugs: ["rag"] };
    expect(syncEntityMirror(v1)).toBe(v1);
  });
});

describe("writeState — persists a consistent v2 mirror", () => {
  it("writes entities matching the changed concepts", async () => {
    await writeState(root, staleV2());
    const persisted = await readPersisted();
    expect(persisted.sources["a.md"].entities).toEqual(["concepts/rag", "concepts/x"]);
  });

  it("writes a frozenEntities with no stale entry after unfreezing", async () => {
    const state = staleV2();
    state.frozenSlugs = ["rag"];
    await writeState(root, state);
    expect((await readPersisted()).frozenEntities).toEqual(["concepts/rag"]);
  });
});

describe("writeState — v1 is byte-identical (parity)", () => {
  it("adds no entities / frozenEntities keys to a persisted v1 state", async () => {
    const v1: WikiState = {
      version: 1,
      indexHash: "i",
      sources: { "a.md": { hash: "h", concepts: ["rag"], compiledAt: "T" } },
      frozenSlugs: ["rag"],
    };
    await writeState(root, v1);
    const raw = await readFile(path.join(root, STATE_FILE), "utf-8");
    expect(raw).toBe(JSON.stringify(v1, null, 2));
    expect(raw).not.toContain("entities");
    expect(raw).not.toContain("frozenEntities");
  });
});
