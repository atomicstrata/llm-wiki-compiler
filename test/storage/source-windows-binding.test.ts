/**
 * @file test/storage/source-windows-binding.test.ts
 * @description The context pack's source windows over their sources. This file
 * uses `materializeSourceWindowsFrom`, which exists only after the window reader
 * was given sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. The sources are an in-memory double holding
 * text by key; opening it answers the locations or `null`, locating answers a
 * token or `null`, reading serves the text or rejects, and every call is
 * logged. The production reader runs on what it serves: the open that comes
 * FIRST for every cited window, its own rules on the key as written (empty,
 * absolute, any `..` segment), the per-pack budget, "any failure is no
 * window", and the thirty-line clamp.
 *
 * NOT SHOWN HERE: how the local disk resolves `sources/`, or decides that a
 * file is inside it. `read-surface-reads.test.ts`, `context-provenance.test.ts`
 * and `read-observers-legacy.test.ts` show that on real files.
 *
 * `materializeSourceWindowsFrom` and its types are also what the context pack's
 * bound reads (`contextPackReadsOver`) call; `context-pack-binding.test.ts`
 * shows that whole consumer. The double is not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import {
  createSourceWindowBudget, materializeSourceWindowsFrom, MAX_SOURCE_WINDOWS, type SourceWindowLocations, type SourceWindowSources,
} from "../../src/context/provenance.js";

/** Sources held in memory: key to text, or to an `Error` its read rejects with. `absent` makes every open answer null. */
function sourcesOf(held: Record<string, string | Error>, absent = false): { sources: SourceWindowSources; log: string[] } {
  const log: string[] = [];
  const locations: SourceWindowLocations = {
    locateSource: async (file) => { log.push(`locate ${file}`); return file in held ? `mem:${file}` : null; },
    readText: async (source) => {
      log.push(`read ${source}`);
      const text = held[source.slice("mem:".length)]!;
      if (text instanceof Error) throw text;
      return text;
    },
  };
  return { sources: { openSources: async () => { log.push("open"); return absent ? null : locations; } }, log };
}

const cite = (file: string, start = 1, end = 1) => ({ file, start, end });

describe("source windows over their sources", () => {
  it("W1 opens, locates and reads once per cited window, opening again for each", async () => {
    const { sources, log } = sourcesOf({ "paper.md": "one\ntwo\nthree\n" });
    const windows = await materializeSourceWindowsFrom(sources, [cite("paper.md", 2, 3), { file: "paper.md" }, cite("paper.md", 1, 1)], createSourceWindowBudget());
    expect(windows).toEqual([{ file: "paper.md", start: 2, end: 3, text: "two\nthree" }, { file: "paper.md", start: 1, end: 1, text: "one" }]);
    expect(log).toEqual(["open", "locate paper.md", "read mem:paper.md", "open", "locate paper.md", "read mem:paper.md"]);
  });

  it.each(["", "/etc/passwd", "../paper.md", "nested/../paper.md", "nested\\..\\paper.md"])("W2 a refused key %j makes exactly the open call", async (key) => {
    const { sources, log } = sourcesOf({ "paper.md": "one\n", [key]: "must never be served\n" });
    expect(await materializeSourceWindowsFrom(sources, [cite(key)], createSourceWindowBudget())).toEqual([]);
    expect(log).toEqual(["open"]);
  });

  it("W3 gives no window when there are no sources to open, when a key cannot be located, and when the read rejects", async () => {
    const none = sourcesOf({ "paper.md": "one\n" }, true);
    expect(await materializeSourceWindowsFrom(none.sources, [cite("paper.md")], createSourceWindowBudget())).toEqual([]);
    const some = sourcesOf({ "broken.md": new Error("EIO: read refused") });
    const budget = createSourceWindowBudget();
    expect(await materializeSourceWindowsFrom(some.sources, [cite("missing.md"), cite("broken.md")], budget)).toEqual([]);
    expect([none.log, some.log]).toEqual([["open"], ["open", "locate missing.md", "open", "locate broken.md", "read mem:broken.md"]]);
    expect(budget.remaining).toBe(MAX_SOURCE_WINDOWS);
  });

  it("W4 stops when the shared budget is spent, and makes no call for an already spent budget", async () => {
    const { sources, log } = sourcesOf({ "paper.md": "one\n" });
    const budget = createSourceWindowBudget();
    budget.remaining = 1;
    expect(await materializeSourceWindowsFrom(sources, [cite("paper.md"), cite("paper.md")], budget)).toHaveLength(1);
    expect(await materializeSourceWindowsFrom(sources, [cite("paper.md")], budget)).toEqual([]);
    expect([budget.remaining, log]).toEqual([0, ["open", "locate paper.md", "read mem:paper.md"]]);
  });

  it("W5 splits CRLF lines and clamps a long range to thirty lines", async () => {
    const { sources } = sourcesOf({ "long.md": Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\r\n") });
    const [window] = await materializeSourceWindowsFrom(sources, [cite("long.md", 1, 40)], createSourceWindowBudget());
    expect([window?.start, window?.end, window?.text.split("\n").length]).toEqual([1, 30, 30]);
  });
});
