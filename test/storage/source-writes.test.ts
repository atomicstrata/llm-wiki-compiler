/**
 * @file test/storage/source-writes.test.ts
 * @description FIXED outcomes for saving a source through `src/storage/`: the
 * three storage functions the source writer moved onto (the no-follow kind
 * probe, the exclusive create and the plain overwrite), and the real
 * `saveSource` over a temp project.
 *
 * What the cases pin is the difference between the two writes. A NEW source is
 * created exclusively: an existing name, a link included, is never opened or
 * written through. An UPDATE is a plain overwrite of a file the writer has
 * just checked is regular; the storage function itself follows a link, which
 * is why that check stays in the writer. The `saveSource` cases fix what each
 * of the three write statuses leaves on disk, that the source identity and not
 * the title names the file, that a second source with the same basename gets
 * a hash-suffixed name, and that a planted link or directory is refused or
 * stepped around exactly as before. A lookup failure that is not "nothing
 * there" comes out as the same error object.
 *
 * The suite's other source-writer files cover the alias and escape cases in
 * more depth; this file does not repeat them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The next `lstat` of exactly `target` rejects with `error`. */
const fault = { target: "", error: null as Error | null };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", () => {
  const actual = realFsPromises;
  const lstat = ((target: unknown, ...rest: unknown[]) => {
    if (fault.error !== null && target === fault.target) {
      const error = fault.error;
      fault.error = null;
      return Promise.reject(error);
    }
    return (actual.lstat as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.lstat;
  return { ...actual, lstat };
});

import { locationKindNoFollow } from "../../src/storage/disk-local-reads.js";
import { createLocationTextExclusive, overwriteLocationText } from "../../src/storage/disk-locations.js";
import { saveSource } from "../../src/utils/source-writer.js";

const SOURCE_ID = "/fixed/external/input/alpha.md";
/** A source document as ingest builds one; only `ingestedAt` is volatile. */
const document = (title: string, body: string, ingestedAt = "2026-01-01T00:00:00.000Z", source = SOURCE_ID): string =>
  `---\ntitle: ${title}\nsource: ${source}\ningestedAt: "${ingestedAt}"\n---\n\n${body}\n`;

let base: string;
let root: string;
const at = (relative: string): string => path.join(root, relative);
const read = (relative: string): Promise<string> => fs.readFile(at(relative), "utf-8");
/** What a promise settles to: its value, or the error it rejected with. */
const settled = <T>(work: Promise<T>): Promise<T | Error> => work.catch((error: Error) => error);

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "llmwiki-source-writes-")));
  root = path.join(base, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, "outside.md"), "OUTSIDE");
  fault.error = null;
});

afterEach(async () => {
  fault.error = null;
  await fs.rm(base, { recursive: true, force: true });
});

describe("the storage functions the source writer uses", () => {
  it("reports what is at a location without following a final link, and rejects raw for nothing there", async () => {
    await fs.writeFile(at("file"), "x");
    await fs.mkdir(at("directory"));
    await fs.symlink(at("directory"), at("link-to-directory"));
    await fs.symlink(at("nowhere"), at("dangling"));
    const kinds = await Promise.all(["file", "directory", "link-to-directory", "dangling"].map((name) => locationKindNoFollow(at(name))));
    expect(kinds).toEqual(["file", "directory", "link", "link"]);
    expect(await settled(locationKindNoFollow(at("missing")))).toMatchObject({ code: "ENOENT" });
    fault.target = at("file");
    fault.error = Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
    const injected = fault.error;
    expect(await settled(locationKindNoFollow(at("file")))).toBe(injected);
  });

  it("creates a new file with exactly the text and never writes over or through an existing name", async () => {
    await createLocationTextExclusive(at("new.md"), "first\n");
    expect(await read("new.md")).toBe("first\n");
    await fs.symlink(path.join(base, "outside.md"), at("link.md"));
    await fs.symlink(at("nowhere"), at("dangling.md"));
    for (const name of ["new.md", "link.md", "dangling.md"]) {
      expect(await settled(createLocationTextExclusive(at(name), "second"))).toMatchObject({ code: "EEXIST" });
    }
    expect(await read("new.md")).toBe("first\n");
    expect(await fs.readFile(path.join(base, "outside.md"), "utf-8")).toBe("OUTSIDE");
    expect(await settled(createLocationTextExclusive(at("no-parent/x.md"), "x"))).toMatchObject({ code: "ENOENT" });
  });

  it("overwrites in place, creates a missing file, and FOLLOWS a link at the location", async () => {
    await fs.writeFile(at("page.md"), "a much longer earlier text");
    await overwriteLocationText(at("page.md"), "short");
    await overwriteLocationText(at("created.md"), "made");
    await fs.symlink(path.join(base, "outside.md"), at("link.md"));
    await overwriteLocationText(at("link.md"), "written through");
    expect([await read("page.md"), await read("created.md")]).toEqual(["short", "made"]);
    expect(await fs.readFile(path.join(base, "outside.md"), "utf-8")).toBe("written through");
    expect(await settled(overwriteLocationText(root, "x"))).toMatchObject({ code: "EISDIR" });
    expect(await settled(overwriteLocationText(at("no-parent/x.md"), "x"))).toMatchObject({ code: "ENOENT" });
  });
});

describe("saveSource, through the storage functions", () => {
  it("creates, leaves an unchanged source's bytes alone, and overwrites a changed one", async () => {
    const first = document("Alpha", "First body.");
    expect(await saveSource(root, "Alpha", first, SOURCE_ID)).toEqual({ path: at("sources/alpha.md"), writeStatus: "created" });
    expect(await read("sources/alpha.md")).toBe(first);
    const sameLater = document("Alpha", "First body.", "2031-12-31T23:59:59.000Z");
    expect(await saveSource(root, "Alpha", sameLater, SOURCE_ID)).toEqual({ path: at("sources/alpha.md"), writeStatus: "unchanged" });
    expect(await read("sources/alpha.md")).toBe(first);
    const changed = document("Alpha", "Second body.", "2031-12-31T23:59:59.000Z");
    expect(await saveSource(root, "Alpha", changed, SOURCE_ID)).toEqual({ path: at("sources/alpha.md"), writeStatus: "updated" });
    expect(await read("sources/alpha.md")).toBe(changed);
  });

  it("updates the same file when the same source arrives under a new title", async () => {
    await saveSource(root, "Alpha", document("Alpha", "Body."), SOURCE_ID);
    const renamed = document("Renamed Entirely", "Body.");
    expect(await saveSource(root, "Renamed Entirely", renamed, SOURCE_ID)).toEqual({ path: at("sources/alpha.md"), writeStatus: "updated" });
    expect(await fs.readdir(at("sources"))).toEqual(["alpha.md"]);
    expect(await read("sources/alpha.md")).toBe(renamed);
  });

  it("gives a different source with the same basename a hash-suffixed name and leaves the first alone", async () => {
    const first = document("Alpha", "Body.");
    await saveSource(root, "Alpha", first, SOURCE_ID);
    const other = document("Alpha", "Other body.", undefined, "/another/place/alpha.md");
    const saved = await saveSource(root, "Alpha", other, "/another/place/alpha.md");
    expect(saved.writeStatus).toBe("created");
    expect(path.basename(saved.path)).toMatch(/^alpha-[0-9a-f]{8}\.md$/u);
    expect(await read("sources/alpha.md")).toBe(first);
    expect(await fs.readFile(saved.path, "utf-8")).toBe(other);
  });

  it("refuses a sources/ that is a link, and a sources that is a file, without writing", async () => {
    await fs.mkdir(path.join(base, "elsewhere"));
    await fs.symlink(path.join(base, "elsewhere"), at("sources"));
    expect(await settled(saveSource(root, "Alpha", document("Alpha", "Body."), SOURCE_ID))).toMatchObject({ message: "sources/ must be a real directory, not a symlink" });
    expect(await fs.readdir(path.join(base, "elsewhere"))).toEqual([]);
    await fs.rm(at("sources"));
    await fs.writeFile(at("sources"), "a file");
    expect(await settled(saveSource(root, "Alpha", document("Alpha", "Body."), SOURCE_ID))).toMatchObject({ code: "EEXIST" });
  });

  it("steps around a planted link or directory at the destination name and never touches it", async () => {
    await fs.mkdir(at("sources"));
    await fs.symlink(path.join(base, "outside.md"), at("sources/alpha.md"));
    const pastLink = await saveSource(root, "Alpha", document("Alpha", "Body."), SOURCE_ID);
    await fs.mkdir(at("sources/beta.md"));
    const pastDirectory = await saveSource(root, "Beta", document("Beta", "Body.", undefined, "/fixed/beta.md"), "/fixed/beta.md");
    expect([pastLink.writeStatus, pastDirectory.writeStatus]).toEqual(["created", "created"]);
    expect(path.basename(pastLink.path)).toMatch(/^alpha-[0-9a-f]{8}\.md$/u);
    expect(path.basename(pastDirectory.path)).toMatch(/^beta-[0-9a-f]{8}\.md$/u);
    expect(await fs.readFile(path.join(base, "outside.md"), "utf-8")).toBe("OUTSIDE");
  });

  it("does not update through an in-tree alias: the alias is skipped and the real file is the one written", async () => {
    await saveSource(root, "Zeta", document("Zeta", "Body.", undefined, "/fixed/zeta.md"), "/fixed/zeta.md");
    await fs.symlink(at("sources/zeta.md"), at("sources/alias.md"));
    const changed = document("Zeta", "Changed body.", undefined, "/fixed/zeta.md");
    expect(await saveSource(root, "Zeta", changed, "/fixed/zeta.md")).toEqual({ path: at("sources/zeta.md"), writeStatus: "updated" });
    expect((await fs.lstat(at("sources/alias.md"))).isSymbolicLink()).toBe(true);
    expect(await read("sources/zeta.md")).toBe(changed);
  });

  it("lets a lookup failure that is not 'nothing there' out as the same error object", async () => {
    await fs.mkdir(at("sources"));
    fault.target = at("sources/alpha.md");
    fault.error = Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
    const injected = fault.error;
    expect(await settled(saveSource(root, "Alpha", document("Alpha", "Body."), SOURCE_ID))).toBe(injected);
    expect(await fs.readdir(at("sources"))).toEqual([]);
  });
});
