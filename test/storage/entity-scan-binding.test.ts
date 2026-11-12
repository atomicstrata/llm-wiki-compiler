/**
 * @file test/storage/entity-scan-binding.test.ts
 * @description The read binding behind the shared entity scan. This file uses
 * `scanEntityDirFrom` and `diskLocalEntityScans`, which exist only after the
 * scan was routed through a binding, so it has NO before-edit run and is not
 * part of the before-and-after comparison in `entity-scan-legacy.test.ts`.
 *
 * M1 and M2 pass an in-memory binding. Its locators are not paths on this
 * machine and its page text exists nowhere on disk, and `scanEntityDirFrom`
 * takes no project root, so whatever comes back can only have come from the
 * binding. Each case also asserts the WHOLE recorded conversation with it.
 * M3 is the positive control: given the disk binding, the same consumer reads
 * a real directory, and reports the binding's locator as the file path.
 *
 * An in-memory object here is a test double. It is not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { diskLocalEntityScans } from "../../src/storage/disk-local-reads.js";
import type { EntityDirectoryOpen, LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import { scanEntityDir, scanEntityDirFrom } from "../../src/wiki/collect.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const CAP = 64 * 1024;
const DIR = "wiki/notes";
const PAGE = (title: string): string => `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
/** A page whose frontmatter is still open at exactly the cap, so the prefix cannot answer. */
const LATE = `---\ntitle: Late\nnote: ${"n".repeat(CAP)}\n---\n\nBody of Late.\n`;
const at = (stem: string): string => `mem://notes/${stem}`;
useTempRoot();

/** Listing order of the memory directory; deliberately not sorted. */
const NAMES = ["zeta.md", "notes.txt", "escaped.md", "broken.md", "late.md", "alpha.md"];
/** Text by locator. `broken` resolves but has no text; `escaped` does not resolve. */
const TEXT: Record<string, string> = { [at("zeta")]: PAGE("Zeta"), [at("late")]: LATE, [at("alpha")]: PAGE("Alpha") };
const RESOLVES = new Set(["zeta.md", "broken.md", "late.md", "alpha.md"]);

/** The text at a memory locator, or a rejection when there is none. */
async function textAt(locator: string): Promise<string> {
  const text = TEXT[locator];
  if (text === undefined) throw new Error(`no text at ${locator}`);
  return text;
}

/** An in-memory binding that records every call made to it, in order. */
function memoryScans(log: unknown[][], opened?: EntityDirectoryOpen): LegacyLocalEntityScans {
  const directory = {
    listNames: async () => { log.push(["list"]); return NAMES; },
    resolveEntry: async (name: string) => { log.push(["resolve", name]); return RESOLVES.has(name) ? at(name.slice(0, -3)) : null; },
    readPrefix: async (locator: string, maxBytes: number) => { log.push(["prefix", locator, maxBytes]); return Buffer.from(await textAt(locator)).subarray(0, maxBytes); },
    readText: async (locator: string) => { log.push(["text", locator]); return textAt(locator); },
  };
  return { openEntityDirectory: async (relDir) => { log.push(["open", relDir]); return opened ?? { status: "ok", directory }; } };
}

/** Directory methods that must not be reached once the listing has failed. */
const failing = {
  resolveEntry: async (): Promise<string | null> => { throw new Error("resolveEntry reached after a failed listing"); },
  readPrefix: async (): Promise<Buffer> => { throw new Error("readPrefix reached after a failed listing"); },
  readText: async (): Promise<string> => { throw new Error("readText reached after a failed listing"); },
};

describe("the entity scan over a binding", () => {
  it("M1 serves a whole listing from memory, in the binding's order, and asks for nothing else", async () => {
    const log: unknown[][] = [];
    const lean = await scanEntityDirFrom(memoryScans(log), DIR, { includeBody: false });
    expect(lean.dirStatus).toBe("ok");
    expect(lean.scans.map((found) => [found.stem, found.filePath, found.frontmatter.title, found.body])).toEqual([
      ["zeta", at("zeta"), "Zeta", ""], ["late", at("late"), "Late", ""], ["alpha", at("alpha"), "Alpha", ""],
    ]);
    expect(log).toEqual([
      ["open", DIR], ["list"],
      ["resolve", "zeta.md"], ["prefix", at("zeta"), CAP],
      ["resolve", "escaped.md"],
      ["resolve", "broken.md"], ["prefix", at("broken"), CAP],
      ["resolve", "late.md"], ["prefix", at("late"), CAP], ["text", at("late")],
      ["resolve", "alpha.md"], ["prefix", at("alpha"), CAP],
    ]);
    log.length = 0;
    const full = await scanEntityDirFrom(memoryScans(log), DIR);
    expect(full.scans.map((found) => [found.stem, found.body.trim()])).toEqual([["zeta", "Body of Zeta."], ["late", "Body of Late."], ["alpha", "Body of Alpha."]]);
    expect(log.filter((call) => call[0] === "prefix")).toEqual([]);
    expect(log.filter((call) => call[0] === "text")).toEqual([["text", at("zeta")], ["text", at("broken")], ["text", at("late")], ["text", at("alpha")]]);
  });

  it("M2 passes a missing or invalid directory through and calls a failed listing missing", async () => {
    const log: unknown[][] = [];
    expect(await scanEntityDirFrom(memoryScans(log, { status: "missing" }), DIR)).toEqual({ scans: [], dirStatus: "missing" });
    expect(await scanEntityDirFrom(memoryScans(log, { status: "invalid" }), DIR)).toEqual({ scans: [], dirStatus: "invalid" });
    expect(log).toEqual([["open", DIR], ["open", DIR]]);
    const unlistable: LegacyLocalEntityScans = {
      openEntityDirectory: async () => ({ status: "ok", directory: { ...failing, listNames: async () => { throw new Error("cannot list"); } } }),
    };
    expect(await scanEntityDirFrom(unlistable, DIR)).toEqual({ scans: [], dirStatus: "missing" });
  });

  it("M3 reads a real directory through the disk binding and reports its locator as the file path", async () => {
    const root = path.join(process.cwd(), "project");
    await fs.mkdir(path.join(root, DIR), { recursive: true });
    await fs.writeFile(path.join(root, DIR, "a.md"), PAGE("A"));
    const absent = diskLocalEntityScans(path.join(process.cwd(), "no-such-project"));
    expect(await absent.openEntityDirectory(DIR)).toEqual({ status: "invalid" });
    const opened = await diskLocalEntityScans(root).openEntityDirectory(DIR);
    if (opened.status !== "ok") throw new Error(`expected the directory to open, got ${opened.status}`);
    const locator = await opened.directory.resolveEntry("a.md");
    expect(locator).toBe(await fs.realpath(path.join(root, DIR, "a.md")));
    expect(await opened.directory.readText(locator!)).toBe(PAGE("A"));
    const scan = await scanEntityDir(root, DIR);
    expect(scan.scans.map((found) => [found.stem, found.filePath])).toEqual([["a", locator]]);
    expect(await scanEntityDirFrom(diskLocalEntityScans(root), DIR)).toEqual(scan);
  });
});
