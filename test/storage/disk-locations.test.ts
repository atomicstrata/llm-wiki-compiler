/**
 * @file test/storage/disk-locations.test.ts
 * @description The two synchronous location probes the `compile` command and
 * the SDK constructor moved onto (`src/storage/disk-locations.ts`), on a temp
 * directory, with FIXED outcomes for each of the six shapes a path can have:
 * missing, a file, a directory, a link to a directory, a link to a file, and
 * a dangling link.
 *
 * What the cases pin is that links are FOLLOWED. An `lstat` in place of the
 * `stat` would make every link case answer differently, and a project root
 * that is a link to a directory would stop being accepted. The race case pins
 * that the second call's own error is thrown unchanged when the location stops
 * resolving between the two calls; it is produced with one narrow module mock.
 *
 * The SDK constructor is exercised through its real entry point, so the same
 * six shapes are shown to mean what they meant before: only a file, reached
 * directly or through a link, is refused, with the existing message.
 *
 * The `compile` command is exercised through its real action with only the
 * orchestrator replaced, so the test can see whether it was reached: nothing
 * named `sources` in the working directory stops before it with the existing
 * warning, and anything there (a directory or a link to one) goes on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** When set, the next `statSync` throws this instead of answering. */
const statFault = { error: null as Error | null };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFs = { ...(await import("node:fs")) };
const realCompilerIndex = { ...(await import("../../src/compiler/index.js")) };

vi.mock("node:fs", () => {
  const actual = realFs;
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    if (statFault.error === null) return actual.statSync(...args);
    const error = statFault.error;
    statFault.error = null;
    throw error;
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

/** Stands in for the compile orchestrator, so reaching it is observable. */
const compileSpy = vi.fn(async () => undefined);

vi.mock("../../src/compiler/index.js", () => ({
  ...realCompilerIndex,
  compile: compileSpy,
}));

import { locationExistsSync, locationIsNonDirectorySync } from "../../src/storage/disk-locations.js";
import { createWikiCore } from "../../src/sdk/core.js";
import compileCommand from "../../src/commands/compile.js";

const NO_SOURCES_WARNING = "No sources found. Run `llmwiki ingest <url>` first.";

/** Each path shape, with the two answers it must give. */
const SHAPES = [
  { shape: "missing", exists: false, nonDirectory: false },
  { shape: "file", exists: true, nonDirectory: true },
  { shape: "directory", exists: true, nonDirectory: false },
  { shape: "link-to-directory", exists: true, nonDirectory: false },
  { shape: "link-to-file", exists: true, nonDirectory: true },
  { shape: "dangling-link", exists: false, nonDirectory: false },
];

let base: string;
const at = (shape: string): string => path.join(base, shape);

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-locations-")));
  statFault.error = null;
  compileSpy.mockClear();
  await writeFile(at("file"), "not a directory");
  await mkdir(at("directory"));
  await symlink(at("directory"), at("link-to-directory"));
  await symlink(at("file"), at("link-to-file"));
  await symlink(at("nowhere"), at("dangling-link"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("locationExistsSync and locationIsNonDirectorySync", () => {
  it.each(SHAPES)("$shape: exists $exists, non-directory $nonDirectory", ({ shape, exists, nonDirectory }) => {
    expect(locationExistsSync(at(shape))).toBe(exists);
    expect(locationIsNonDirectorySync(at(shape))).toBe(nonDirectory);
  });

  it("uses a relative location exactly as given, against the working directory", () => {
    const cwd = process.cwd();
    try {
      process.chdir(base);
      expect(locationExistsSync("directory")).toBe(true);
      expect(locationExistsSync("missing")).toBe(false);
      expect(locationIsNonDirectorySync("file")).toBe(true);
      expect(locationIsNonDirectorySync("link-to-directory")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("throws the stat error itself when the location stops resolving between the two calls", () => {
    const vanished = Object.assign(new Error("ENOENT: vanished between the calls"), { code: "ENOENT" });
    statFault.error = vanished;
    let thrown: unknown;
    try { locationIsNonDirectorySync(at("file")); } catch (error) { thrown = error; }
    expect(thrown).toBe(vanished);
    statFault.error = vanished;
    expect(locationIsNonDirectorySync(at("missing"))).toBe(false);
    expect(statFault.error).toBe(vanished);
  });
});

describe("createWikiCore's root check, through the real constructor", () => {
  it.each(SHAPES)("$shape as the root", ({ shape, nonDirectory }) => {
    const construct = (): unknown => createWikiCore({ root: at(shape) });
    if (nonDirectory) expect(construct).toThrow(`createWiki: root exists but is not a directory: ${at(shape)}`);
    else expect(construct).not.toThrow();
  });

  it("lets the raw stat error out of the constructor on the race", () => {
    const vanished = Object.assign(new Error("EACCES: raced"), { code: "EACCES" });
    statFault.error = vanished;
    let thrown: unknown;
    try { createWikiCore({ root: at("directory") }); } catch (error) { thrown = error; }
    expect(thrown).toBe(vanished);
  });
});

/** Run the real `compile` action with `sources` in the working directory as `shape`; returns what it printed. */
async function runCompileWithSourcesAs(shape: string | null): Promise<string> {
  const project = at("directory");
  if (shape !== null) await symlink(at(shape), path.join(project, "sources"));
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { printed.push(String(line)); });
  const cwd = process.cwd();
  try {
    process.chdir(project);
    await compileCommand({});
  } finally {
    process.chdir(cwd);
    log.mockRestore();
  }
  return printed.join("\n");
}

describe("the compile command's sources check, through the real action", () => {
  it.each([null, "missing"])("stops with the warning when `sources` is %s", async (shape) => {
    expect(await runCompileWithSourcesAs(shape)).toContain(NO_SOURCES_WARNING);
    expect(compileSpy).not.toHaveBeenCalled();
  });

  it.each(["directory", "file"])("goes on to the orchestrator when `sources` resolves to a %s", async (shape) => {
    expect(await runCompileWithSourcesAs(shape)).not.toContain(NO_SOURCES_WARNING);
    expect(compileSpy).toHaveBeenCalledTimes(1);
  });
});
