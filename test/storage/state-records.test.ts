/**
 * @file test/storage/state-records.test.ts
 * @description Port witness for the compile-state record: the state module's
 * REAL classification, recovery and serialization run over an in-memory record
 * binding, with no directory anywhere.
 *
 * The binding here is a test double that stores text in a map and logs every
 * call. It decides nothing: what "missing", "corrupt" and "too-new" mean, when
 * a backup is taken, what is refused and what bytes are written all come from
 * `src/utils/state.ts`. So these cases pin which decisions live ABOVE the
 * binding, and that the classified read stays free of side effects while the
 * recovering read does not.
 *
 * The last case calls the compile-state DRAFT's memory seam directly
 * (`CompileStateDraft.loadFrom`, `removeSource`, `flushTo`): an in-memory removal
 * touches no record, and the one flush is the single write of the final state.
 */

import { describe, expect, it } from "bun:test";
import { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";
import {
  readStateClassifiedFrom, readStateFrom, StateTooNewError, writeStateTo,
} from "../../src/utils/state.js";
import type { WikiState } from "../../src/utils/types.js";
import { withQuiet } from "../../src/utils/output.js";

const STATE = ".llmwiki/state.json";
const BACKUP = ".llmwiki/state.json.bak";

/** A record binding over a map, with a log of the calls made on it. */
function memoryRecords(initial: Record<string, string> = {}, unreadable = false) {
  const files = new Map(Object.entries(initial));
  const calls: string[] = [];
  const records: LegacyLocalRecords = {
    exists: async (relPath) => { calls.push(`exists ${relPath}`); return files.has(relPath); },
    readTextNoFollow: async (relPath) => {
      calls.push(`read ${relPath}`);
      if (unreadable || !files.has(relPath)) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
      return files.get(relPath)!;
    },
    copy: async (from, to) => { calls.push(`copy ${from} ${to}`); files.set(to, files.get(from)!); },
    writeAtomic: async (relPath, text) => { calls.push(`write ${relPath}`); files.set(relPath, text); },
    locate: (relPath) => `memory:${relPath}`,
  };
  return { records, files, calls };
}

const V1: WikiState = {
  version: 1, indexHash: "", sources: { "a.md": { hash: "h1", concepts: ["alpha"], compiledAt: "2026-01-01T00:00:00.000Z" } },
};
const EMPTY: WikiState = { version: 1, indexHash: "", sources: {} };

describe("classified compile-state read over a memory record binding", () => {
  it("classifies missing, ok, corrupt and too-new without copying or writing", async () => {
    const statusOf = async (text?: string): Promise<[string, string[]]> => {
      const { records, calls } = memoryRecords(text === undefined ? {} : { [STATE]: text });
      return [(await readStateClassifiedFrom(records)).status, calls];
    };
    expect(await statusOf()).toEqual(["missing", [`exists ${STATE}`]]);
    expect(await statusOf(JSON.stringify(V1))).toEqual(["ok", [`exists ${STATE}`, `read ${STATE}`]]);
    expect(await statusOf("{ not json")).toEqual(["corrupt", [`exists ${STATE}`, `read ${STATE}`]]);
    expect(await statusOf(JSON.stringify({ ...V1, version: 99 }))).toEqual(["too-new", [`exists ${STATE}`, `read ${STATE}`]]);
  });

  it("classifies a record that exists but cannot be read as corrupt, and a poisoned slug as corrupt", async () => {
    const unreadable = memoryRecords({ [STATE]: JSON.stringify(V1) }, true);
    expect(await readStateClassifiedFrom(unreadable.records)).toEqual({ status: "corrupt", state: EMPTY });
    const poisoned = { ...V1, sources: { "a.md": { ...V1.sources["a.md"], concepts: ["../../escape"] } } };
    expect((await readStateClassifiedFrom(memoryRecords({ [STATE]: JSON.stringify(poisoned) }).records)).status).toBe("corrupt");
  });
});

describe("recovering compile-state read over a memory record binding", () => {
  it("returns a healthy state and touches nothing", async () => {
    const { records, calls } = memoryRecords({ [STATE]: JSON.stringify(V1) });
    expect(await readStateFrom(records)).toEqual(V1);
    expect(calls).toEqual([`exists ${STATE}`, `read ${STATE}`]);
  });

  it("backs a corrupt record up byte for byte, then starts fresh without rewriting it", async () => {
    const { records, files, calls } = memoryRecords({ [STATE]: "{ not json" });
    expect(await withQuiet(() => readStateFrom(records))).toEqual(EMPTY);
    expect(calls).toEqual([`exists ${STATE}`, `read ${STATE}`, `copy ${STATE} ${BACKUP}`]);
    expect([files.get(BACKUP), files.get(STATE)]).toEqual(["{ not json", "{ not json"]);
  });

  it("refuses a too-new record: no backup, no write, the stored bytes untouched", async () => {
    const tooNew = JSON.stringify({ ...V1, version: 99 });
    const { records, files, calls } = memoryRecords({ [STATE]: tooNew });
    await expect(readStateFrom(records)).rejects.toBeInstanceOf(StateTooNewError);
    expect(calls).toEqual([`exists ${STATE}`, `read ${STATE}`]);
    expect([...files.entries()]).toEqual([[STATE, tooNew]]);
  });
});

describe("compile-state write over a memory record binding", () => {
  it("writes a version 1 state as exactly its two-space JSON, with no typed mirror added", async () => {
    const { records, files, calls } = memoryRecords();
    await writeStateTo(records, V1);
    expect(files.get(STATE)).toBe(JSON.stringify(V1, null, 2));
    expect(calls).toEqual([`write ${STATE}`]);
  });

  it("re-derives the version 2 typed mirror at the write, whatever the caller passed", async () => {
    // Parsed from text, as a stored record is: the mirror fields are plain strings on disk.
    const stale = JSON.parse(JSON.stringify({
      version: 2, indexHash: "", frozenSlugs: ["beta"], frozenEntities: ["concepts/stale"],
      sources: { "a.md": { ...V1.sources["a.md"], entities: ["concepts/stale"] } },
    })) as WikiState;
    const { records, files } = memoryRecords();
    await writeStateTo(records, stale);
    const written = JSON.parse(files.get(STATE)!) as WikiState;
    expect(written.sources["a.md"].entities).toEqual(["concepts/alpha"]);
    expect(written.frozenEntities).toEqual(["concepts/beta"]);
    expect(await readStateFrom(records)).toEqual(written);
  });
});

describe("compile-state draft over a memory record binding", () => {
  it("removes a source in memory only, then flushes ONE write of exactly the final state", async () => {
    const two: WikiState = { ...V1, sources: { ...V1.sources, "b.md": { hash: "h2", concepts: ["beta"], compiledAt: "2026-01-02T00:00:00.000Z" } } };
    const { records, files, calls } = memoryRecords({ [STATE]: JSON.stringify(two) });
    // Typed explicitly: the health analyzer links `removeSource`/`flushTo` to the class only through an annotated receiver.
    const draft: CompileStateDraft = await CompileStateDraft.loadFrom(records);
    draft.removeSource("b.md");
    expect([draft.read(), files.get(STATE), calls]).toEqual([V1, JSON.stringify(two), [`exists ${STATE}`, `read ${STATE}`]]);
    await draft.flushTo(records);
    expect([files.get(STATE), calls.slice(2)]).toEqual([JSON.stringify(V1, null, 2), [`write ${STATE}`]]);
    expect(await readStateFrom(records)).toEqual(V1);
  });
});
