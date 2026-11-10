/**
 * @file test/storage/read-surface-reads.test.ts
 * @description FIXED outcomes for the two read helpers that page, context and
 * MCP readers reach through `src/storage/`: `safeReadFile`, which answers the
 * file's text or an empty string and never rejects, and the context pack's
 * source-window resolver, which resolves `sources/`, then the cited file, then
 * reads it once.
 *
 * What is pinned is what a caller observes on real files: decoded text
 * (including non-ASCII), the empty string for every kind of failure, the order
 * of the resolver's three calls, that a link leaving `sources/` is never read,
 * CRLF handling and the thirty-line clamp, and that the SDK's page readers
 * still give a body, `null` for a missing page, and an empty body for a page
 * whose file cannot be read.
 *
 * Calls are observed through a module mock of `fs/promises` that forwards to
 * the real filesystem and can fail one chosen read. The storage file imports
 * `node:fs/promises`; the mock reaching it is part of what is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as real from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Calls seen by the mock, and the one path whose read is made to fail. */
const watch = (() => ({ seen: [] as string[], unreadable: "" }))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const disk = (realFsPromises as typeof import("fs/promises"));
  const readFile = (target: unknown, ...options: unknown[]): unknown => {
    watch.seen.push(`readFile ${String(target)} ${JSON.stringify(options)}`);
    if (target === watch.unreadable) return Promise.reject(Object.assign(new Error("planted read failure"), { code: "EIO" }));
    return (disk.readFile as (...args: unknown[]) => unknown)(target, ...options);
  };
  const realpath = (target: unknown, ...options: unknown[]): unknown => {
    watch.seen.push(`realpath ${String(target)}`);
    return (disk.realpath as (...args: unknown[]) => unknown)(target, ...options);
  };
  return { ...disk, readFile, realpath };
});

import { safeReadFile } from "../../src/utils/markdown.js";
import { createSourceWindowBudget, materializeSourceWindows } from "../../src/context/provenance.js";
import { getPage, listPages } from "../../src/pages/list.js";

const ACCENTED = "Zoë's café — naïve ✓\nsecond line\n";
let workspace = "";

const inside = (relative: string): string => path.join(workspace, relative);
/** The recorded calls with the workspace prefix removed. */
const recorded = (): string[] => watch.seen.map((entry) => entry.split(`${workspace}/`).join(""));

/** Create each file, with its directories, under the workspace. */
async function seed(files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await real.mkdir(path.dirname(inside(relative)), { recursive: true });
    await real.writeFile(inside(relative), text);
  }
}

beforeEach(async () => {
  workspace = await real.realpath(await real.mkdtemp(path.join(tmpdir(), "read-surfaces-")));
  watch.seen = []; watch.unreadable = "";
});

afterEach(() => real.rm(workspace, { recursive: true, force: true }));

describe("safeReadFile: the text, or an empty string, and never a rejection", () => {
  it("returns non-ASCII text decoded as UTF-8, with one read", async () => {
    await seed({ "page.md": ACCENTED });
    expect(await safeReadFile(inside("page.md"))).toBe(ACCENTED);
    expect(recorded()).toEqual(['readFile page.md ["utf-8"]']);
  });

  it("answers an empty string for a missing file, a directory and a failed read", async () => {
    await seed({ "dir/inner.md": "x", "present.md": "text" });
    watch.unreadable = inside("present.md");
    expect([await safeReadFile(inside("absent.md")), await safeReadFile(inside("dir")), await safeReadFile(inside("present.md"))]).toEqual(["", "", ""]);
  });
});

describe("source windows: resolve sources/, resolve the file, read it once", () => {
  const cite = (file: string, start: number, end: number) => [{ file, start, end }];
  const windowsFor = (file: string, start: number, end: number) => materializeSourceWindows(workspace, cite(file, start, end), createSourceWindowBudget());

  it("makes its three calls in order and returns the cited lines", async () => {
    await seed({ "sources/paper.md": "one\ntwo\nthree\nfour\n" });
    expect(await windowsFor("paper.md", 2, 3)).toEqual([{ file: "paper.md", start: 2, end: 3, text: "two\nthree" }]);
    expect(recorded()).toEqual(["realpath sources", "realpath sources/paper.md", 'readFile sources/paper.md ["utf-8"]']);
  });

  it("gives no window, and reads nothing, for a link that leaves sources/", async () => {
    await seed({ "sources/kept.md": "kept\n", "outside.md": "secret\n" });
    await real.symlink(inside("outside.md"), inside("sources/leak.md"));
    expect(await windowsFor("leak.md", 1, 1)).toEqual([]);
    expect(recorded().filter((entry) => entry.startsWith("readFile"))).toEqual([]);
  });

  it("gives no window for a failed read, and stops at the first call without sources/", async () => {
    await seed({ "sources/paper.md": "one\n" });
    watch.unreadable = inside("sources/paper.md");
    expect(await windowsFor("paper.md", 1, 1)).toEqual([]);
    await real.rm(inside("sources"), { recursive: true });
    watch.seen = [];
    expect(await windowsFor("paper.md", 1, 1)).toEqual([]);
    expect(recorded()).toEqual(["realpath sources"]);
  });

  it("splits CRLF lines and clamps a long range to thirty lines", async () => {
    await seed({ "sources/long.md": Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\r\n") });
    const [window] = await windowsFor("long.md", 1, 40);
    expect(window).toMatchObject({ start: 1, end: 30 });
    expect(window?.text.split("\n")).toEqual(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`));
  });
});

describe("the SDK page readers, which read through safeReadFile", () => {
  const PAGE = `---\ntitle: "Accented"\nsummary: "A page."\n---\n\n${ACCENTED}`;

  it("returns a present page's body and null for a missing page", async () => {
    await seed({ "wiki/concepts/accented.md": PAGE });
    expect((await getPage(workspace, { pageDirectory: "concepts", slug: "accented" }))?.body).toContain("Zoë's café — naïve ✓");
    expect(await getPage(workspace, { pageDirectory: "concepts", slug: "absent" })).toBeNull();
  });

  it("lists a body when asked, and an empty body for a page whose read fails", async () => {
    await seed({ "wiki/concepts/accented.md": PAGE, "wiki/queries/other.md": PAGE.replace("Accented", "Other") });
    const bodies = async (): Promise<Array<[string, string | undefined]>> => (await listPages(workspace, { includeBody: true })).pages.map((page) => [page.slug, page.body?.trim()]);
    expect(await bodies()).toEqual([["accented", ACCENTED.trim()], ["other", ACCENTED.trim()]]);
    watch.unreadable = inside("wiki/queries/other.md");
    expect(await bodies()).toEqual([["accented", ACCENTED.trim()], ["other", ""]]);
  });
});
