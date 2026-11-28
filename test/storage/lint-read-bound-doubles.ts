/**
 * @file test/storage/lint-read-bound-doubles.ts
 * @description A deterministic in-memory {@link LintPageSources} that MEASURES
 * the page collection's body reads: how many are in flight at once (each read
 * completes only on a later event-loop turn, so concurrent reads really
 * overlap), the peak, and the total. It answers facts only; it schedules,
 * caches and orders nothing, so any bound it observes is the collection's own.
 */

import { setImmediate } from "node:timers/promises";
import type { LintPageSources } from "../../src/linter/rules-shared.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";

/** A project as facts: directory entries in listing order, file texts, and reads that fail. */
export interface ReadFacts {
  directories: Map<string, LocalEntry[]>;
  files: Map<string, string>;
  failing: Map<string, Error>;
  /** Directories whose typed listing rejects. */
  unlistable: Set<string>;
}

/** What the double observed about body reads. */
export interface ReadWork { active: number; peak: number; reads: number }

/** Empty facts to fill. */
export function emptyFacts(): ReadFacts {
  return { directories: new Map(), files: new Map(), failing: new Map(), unlistable: new Set() };
}

/** Add an entry to `dir`, creating the directory (and its parents' entries) as needed. */
export function addEntry(facts: ReadFacts, dir: string, entry: LocalEntry, text?: string): void {
  if (!facts.directories.has(dir)) facts.directories.set(dir, []);
  facts.directories.get(dir)!.push(entry);
  if (entry.kind === "directory" && !facts.directories.has(`${dir}/${entry.name}`)) facts.directories.set(`${dir}/${entry.name}`, []);
  if (text !== undefined) facts.files.set(`${dir}/${entry.name}`, text);
}

/** The measuring sources over `facts`. */
export function measuringSources(facts: ReadFacts): { sources: LintPageSources; work: ReadWork } {
  const work: ReadWork = { active: 0, peak: 0, reads: 0 };
  const sources: LintPageSources = {
    exists: async (relPath) => facts.directories.has(relPath) || facts.files.has(relPath),
    listNames: async (relDir) => (facts.directories.get(relDir) ?? []).map((entry) => entry.name),
    listEntries: async (relDir) => {
      if (facts.unlistable.has(relDir)) throw new Error(`cannot list ${relDir}`);
      return facts.directories.get(relDir) ?? [];
    },
    locate: (relPath) => `/project/${relPath}`,
    readText: async (relPath) => {
      work.active += 1;
      work.reads += 1;
      work.peak = Math.max(work.peak, work.active);
      try {
        await setImmediate();
        const failure = facts.failing.get(relPath);
        if (failure) throw failure;
        return facts.files.get(relPath) ?? "";
      } finally {
        work.active -= 1;
      }
    },
  };
  return { sources, work };
}

/** `count` generic pages, alternating concepts and queries, listed in DESCENDING name order. */
export function genericFacts(count: number): ReadFacts {
  const facts = emptyFacts();
  for (let index = count - 1; index >= 0; index -= 1) {
    const dir = index % 2 ? "wiki/queries" : "wiki/concepts";
    addEntry(facts, dir, { name: `page-${String(index).padStart(4, "0")}.md`, kind: "file" }, `# Page ${index}\n`);
  }
  return facts;
}

/** `count` wiki-wide pages spread over nested directories up to five levels deep, listed unsorted. */
export function nestedFacts(count: number): ReadFacts {
  const facts = emptyFacts();
  for (let index = count - 1; index >= 0; index -= 1) {
    const levels = ["wiki", ...Array.from({ length: index % 5 }, (_, depth) => `d${depth}-${index % 3}`)];
    for (let depth = 1; depth < levels.length; depth += 1) {
      const parent = levels.slice(0, depth).join("/");
      if (!(facts.directories.get(parent) ?? []).some((entry) => entry.name === levels[depth])) addEntry(facts, parent, { name: levels[depth]!, kind: "directory" });
    }
    addEntry(facts, levels.join("/"), { name: `n-${String(index).padStart(4, "0")}.md`, kind: "file" }, `# Nested ${index}\n`);
  }
  return facts;
}
