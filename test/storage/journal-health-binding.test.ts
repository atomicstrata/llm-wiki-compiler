/**
 * @file test/storage/journal-health-binding.test.ts
 * @description Journal health over its sources. This file uses
 * `journalHealthFrom`, `journalHealthWarningFrom`, `classifyJournalFileFrom` and
 * `listBatchIdsFrom`, which exist only after the journal readers were given
 * sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. The journal is an in-memory double: it answers
 * what opening found, lists the names it holds, serves a batch's text or `null`,
 * and answers whether a target is confined from a fixed set. It decides
 * nothing. The production readers run on what it serves: "absent is ok",
 * "escape is unavailable", the `.json` filter, listing order, the parse and
 * shape check, committed versus pending, "an unconfined target is unsafe",
 * "the first unsafe file stops the read", and the two warning texts.
 *
 * NOT SHOWN HERE: how the local disk resolves the journal directory, reads a
 * batch without following a link, or confines a target against either spelling
 * of the root. Those are exercised only by the disk tests
 * (`journal-health.test.ts`, `journal-strict-recovery.test.ts`,
 * `read-observers-legacy.test.ts`).
 *
 * The double is a test double. It is not a hosted store, not an access-control
 * layer and not `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyJournalFileFrom, listBatchIdsFrom, type JournalBatches, type JournalOpening, type JournalReadSources,
} from "../../src/trust/journal-classify.js";
import { journalHealthFrom } from "../../src/trust/journal-health.js";
import { journalHealthWarningFrom } from "../../src/trust/journal-health-warning.js";

interface Held {
  /** Name to text, in listing order; `null` means the read answers null. */
  files: Record<string, string | null>;
  /** Targets the double answers "confined" for; every other target is not. */
  confined?: string[];
  /** When set, listing rejects with it. */
  listError?: Error;
}

/** A journal held in memory; every call is logged. */
function journalOf(held: Held): { journal: JournalBatches; log: string[] } {
  const log: string[] = [];
  const journal: JournalBatches = {
    listNames: async () => { log.push("list"); if (held.listError) throw held.listError; return Object.keys(held.files); },
    readBatchText: async (batchId) => { log.push(`read ${batchId}`); return held.files[`${batchId}.json`] ?? null; },
    targetConfined: async (targetPath) => { log.push(`confined ${targetPath}`); return (held.confined ?? []).includes(targetPath); },
  };
  return { journal, log };
}

/** Sources that answer `opening` and log the open. */
function sourcesOf(opening: JournalOpening, log: string[] = []): { sources: JournalReadSources; log: string[] } {
  return { sources: { openJournal: async () => { log.push("open"); return opening; } }, log };
}

/** An opened in-memory journal as sources, sharing one call log. */
function opened(held: Held) {
  const { journal, log } = journalOf(held);
  return sourcesOf({ kind: "ok", journal }, log);
}

/** A batch file's text. `carried` puts a `root` property in the file itself. */
const batch = (status: string, targets: string[], carried?: string): string =>
  JSON.stringify({ batchId: "b", ...(carried === undefined ? {} : { root: carried }), status, entries: targets.map((targetPath) => ({ targetPath, preState: { absent: true } })) });

describe("journal health over its sources", () => {
  it("H1 answers ok for no journal and unavailable for one that leaves the project, making only the open call", async () => {
    const absent = sourcesOf({ kind: "absent" });
    expect(await journalHealthFrom(absent.sources)).toEqual({ status: "ok" });
    const escape = sourcesOf({ kind: "escape" });
    expect(await journalHealthFrom(escape.sources)).toEqual({ status: "unavailable" });
    expect([absent.log, escape.log]).toEqual([["open"], ["open"]]);
  });

  it("H2 keeps only .json names, in listing order, and ignores a committed batch", async () => {
    const { sources, log } = opened({ files: { "z.json": batch("committed", ["t"]), "notes.txt": "x", "a.json": batch("committed", []) } });
    expect(await journalHealthFrom(sources)).toEqual({ status: "ok" });
    expect(log).toEqual(["open", "list", "read z", "read a"]);
  });

  it("H3 answers pending for a pending batch whose every target is confined, asking each target in order", async () => {
    const { sources, log } = opened({ files: { "p.json": batch("pending", ["one", "two"]) }, confined: ["one", "two"] });
    expect(await journalHealthFrom(sources)).toEqual({ status: "pending" });
    expect(log).toEqual(["open", "list", "read p", "confined one", "confined two"]);
  });

  it.each([
    ["a read that answers null", null],
    ["text that is not JSON", "not json {{{"],
    ["a batch of the wrong shape", JSON.stringify({ status: "pending", entries: "nope" })],
  ])("H4 answers unavailable for %s and reads no later batch", async (_label, text) => {
    const { sources, log } = opened({ files: { "bad.json": text, "later.json": batch("pending", ["one"]) }, confined: ["one"] });
    expect(await journalHealthFrom(sources)).toEqual({ status: "unavailable" });
    expect(log).toEqual(["open", "list", "read bad"]);
  });

  it("H5 stops at the first target that is not confined, and at that batch", async () => {
    const { sources, log } = opened({ files: { "p.json": batch("pending", ["one", "outside", "three"]), "later.json": batch("pending", ["one"]) }, confined: ["one", "three"] });
    expect(await journalHealthFrom(sources)).toEqual({ status: "unavailable" });
    expect(log).toEqual(["open", "list", "read p", "confined one", "confined outside"]);
  });

  it("H6 never reads a root the batch file carries: confinement is the double's answer alone", async () => {
    const { journal, log } = journalOf({ files: { "wide.json": batch("pending", ["outside"], "/"), "near.json": batch("pending", ["inside"], "/elsewhere") }, confined: ["inside"] });
    expect([await classifyJournalFileFrom(journal, "wide"), await classifyJournalFileFrom(journal, "near")]).toEqual(["unsafe", "pending-revertable"]);
    expect(log).toEqual(["read wide", "confined outside", "read near", "confined inside"]);
  });

  it("H7 rejects with the listing's own error object", async () => {
    const refused = Object.assign(new Error("EACCES: listing refused"), { code: "EACCES" });
    const { sources, log } = opened({ files: {}, listError: refused });
    await expect(journalHealthFrom(sources)).rejects.toBe(refused);
    expect(log).toEqual(["open", "list"]);
    expect(await listBatchIdsFrom({ listNames: async () => ["b.json", "a.json", "c.txt", "d.json.bak"] })).toEqual(["b", "a"]);
  });
});

describe("the journal warning over its sources", () => {
  it("W1 maps pending and unavailable to their two codes and literal texts, and ok to null", async () => {
    const pending = opened({ files: { "p.json": batch("pending", ["one"]) }, confined: ["one"] });
    expect(await journalHealthWarningFrom(pending.sources)).toEqual({
      code: "incomplete-compile",
      message: "A prior project mutation did not finish; run `llmwiki recover` to recover. The wiki may reflect partial, post-crash state.",
    });
    expect(await journalHealthWarningFrom(sourcesOf({ kind: "escape" }).sources)).toEqual({
      code: "journal-unavailable",
      message: "The project mutation journal is unavailable (corrupt, unreadable, or escaping the project root); content may be partial or tampered. Run `llmwiki recover` to recover.",
    });
    expect(await journalHealthWarningFrom(sourcesOf({ kind: "absent" }).sources)).toBeNull();
  });
});
