/**
 * Tests for {@link CompileStateDraft} — the in-memory compile-state buffer.
 *
 * The draft accumulates every compile-time state mutation
 * (`setSource`/`removeSource`/`setFrozen`) in memory and persists them with a
 * SINGLE durable {@link CompileStateDraft.flush}, so a crash before the flush
 * re-runs the whole compile rather than leaving a half-written state.json.
 *
 * The core gate is STRUCTURAL EQUIVALENCE: a sequence of draft mutations
 * followed by one flush must produce a state.json structurally equal to the same
 * sequence applied through the incremental on-disk
 * `updateSourceState`/`removeSourceState`/frozen path. A second gate (HIGH-B)
 * proves `flush` routes through `writeState` → `syncEntityMirror`, re-syncing the
 * v2 typed mirror rather than serialising the in-memory state verbatim.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { CompileStateDraft } from "../src/compiler/compile-state-draft.js";
import {
  writeState,
  readState,
  updateSourceState,
  removeSourceState,
} from "../src/utils/state.js";
import { STATE_FILE } from "../src/utils/constants.js";
import { readPersistedState } from "./fixtures/state-json.js";
import type { SourceState, WikiState } from "../src/utils/types.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "compile-draft-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read and parse the persisted state.json for the current test root. */
const readPersisted = (): Promise<WikiState> => readPersistedState(root);

/** A baseline v1 state with two sources and one frozen slug. */
function seedState(): WikiState {
  return {
    version: 1,
    indexHash: "idx",
    sources: {
      "a.md": { hash: "ha", concepts: ["rag", "vector"], compiledAt: "T0" },
      "b.md": { hash: "hb", concepts: ["llm"], compiledAt: "T0" },
    },
    frozenSlugs: ["vector"],
  };
}

/** A source entry to add via either path. */
function newEntry(): SourceState {
  return { hash: "hc", concepts: ["agents"], compiledAt: "Tc" };
}

/** Apply the canonical mutation sequence through the draft + one flush. */
async function applyDraftSequence(root: string): Promise<void> {
  const draft = await CompileStateDraft.load(root);
  draft.setSource("c.md", newEntry());
  draft.removeSource("b.md");
  draft.setFrozen(new Set(["rag"]));
  await draft.flush(root);
}

/** Strip volatile compiledAt timestamps so structural compares are stable. */
function stripTimestamps(state: WikiState): WikiState {
  const sources: Record<string, SourceState> = {};
  for (const [file, src] of Object.entries(state.sources)) {
    sources[file] = { ...src, compiledAt: "" };
  }
  return { ...state, sources };
}

describe("CompileStateDraft — seeding and in-memory reads", () => {
  it("load() reflects the current on-disk state via read()", async () => {
    await writeState(root, seedState());
    const draft = await CompileStateDraft.load(root);
    expect(draft.read().sources["a.md"].concepts).toEqual(["rag", "vector"]);
    expect(draft.read().frozenSlugs).toEqual(["vector"]);
  });

  it("setSource changes read() but writes NOTHING to disk before flush", async () => {
    await writeState(root, seedState());
    const draft = await CompileStateDraft.load(root);
    draft.setSource("c.md", newEntry());
    expect(draft.read().sources["c.md"]).toEqual(newEntry());
    expect((await readPersisted()).sources["c.md"]).toBeUndefined();
  });

  it("removeSource changes read() but writes NOTHING to disk before flush", async () => {
    await writeState(root, seedState());
    const draft = await CompileStateDraft.load(root);
    draft.removeSource("b.md");
    expect(draft.read().sources["b.md"]).toBeUndefined();
    expect((await readPersisted()).sources["b.md"]).toBeDefined();
  });

  it("setFrozen changes read() but writes NOTHING to disk before flush", async () => {
    await writeState(root, seedState());
    const draft = await CompileStateDraft.load(root);
    draft.setFrozen(new Set(["rag"]));
    expect(draft.read().frozenSlugs).toEqual(["rag"]);
    expect((await readPersisted()).frozenSlugs).toEqual(["vector"]);
  });
});

describe("CompileStateDraft — single flush persists every mutation", () => {
  it("flush writes all accumulated mutations at once", async () => {
    await writeState(root, seedState());
    await applyDraftSequence(root);

    const persisted = await readPersisted();
    expect(persisted.sources["c.md"]).toEqual(newEntry());
    expect(persisted.sources["b.md"]).toBeUndefined();
    expect(persisted.frozenSlugs).toEqual(["rag"]);
  });
});

describe("CompileStateDraft — structural equivalence with the incremental path", () => {
  /** Apply the same mutation sequence through the incremental on-disk path. */
  async function applyIncremental(): Promise<void> {
    await updateSourceState(root, "c.md", newEntry());
    await removeSourceState(root, "b.md");
    const state = await readState(root);
    await writeState(root, { ...state, frozenSlugs: Array.from(new Set(["rag"])) });
  }

  it("produces a state.json structurally equal to the incremental path", async () => {
    await writeState(root, seedState());
    await applyIncremental();
    const incremental = stripTimestamps(await readPersisted());

    await rm(path.join(root, STATE_FILE));
    await writeState(root, seedState());
    await applyDraftSequence(root);
    const drafted = stripTimestamps(await readPersisted());

    expect(drafted).toEqual(incremental);
  });

  it("preserves top-level key order / normalization (raw bytes match)", async () => {
    await writeState(root, seedState());
    await applyIncremental();
    const incrementalRaw = await readFile(path.join(root, STATE_FILE), "utf-8");

    await rm(path.join(root, STATE_FILE));
    await writeState(root, seedState());
    await applyDraftSequence(root);
    const draftedRaw = await readFile(path.join(root, STATE_FILE), "utf-8");

    expect(draftedRaw).toBe(incrementalRaw);
  });
});

describe("CompileStateDraft — flush re-syncs the v2 typed mirror (HIGH-B)", () => {
  /** A v2 state with a deliberately stale typed mirror. */
  function staleV2(): WikiState {
    return {
      version: 2,
      indexHash: "idx",
      sources: {
        "a.md": {
          hash: "ha",
          concepts: ["rag"],
          compiledAt: "T0",
          entities: ["concepts/rag", "concepts/stale"],
        },
      },
      frozenSlugs: ["rag"],
      frozenEntities: ["concepts/rag", "concepts/ghost"],
    };
  }

  it("re-derives entities from concepts on flush (writeState→syncEntityMirror)", async () => {
    await writeState(root, staleV2());
    const draft = await CompileStateDraft.load(root);
    draft.setSource("b.md", { hash: "hb", concepts: ["llm"], compiledAt: "Tb" });
    await draft.flush(root);

    const persisted = await readPersisted();
    expect(persisted.sources["a.md"].entities).toEqual(["concepts/rag"]);
    expect(persisted.sources["b.md"].entities).toEqual(["concepts/llm"]);
  });

  it("re-derives frozenEntities from frozenSlugs on flush", async () => {
    await writeState(root, staleV2());
    const draft = await CompileStateDraft.load(root);
    draft.setFrozen(new Set(["rag", "vector"]));
    await draft.flush(root);

    expect((await readPersisted()).frozenEntities).toEqual(["concepts/rag", "concepts/vector"]);
  });
});
