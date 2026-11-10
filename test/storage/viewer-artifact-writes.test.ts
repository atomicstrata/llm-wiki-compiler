/**
 * @file test/storage/viewer-artifact-writes.test.ts
 * @description FIXED outcomes for `writeDerivedArtifact`, the one function
 * that writes the viewer's derived navigation artifacts (the Obsidian graph
 * configuration and the Canvas map), now that its two filesystem calls go
 * through `src/storage/`: the parent directories are made, then the file is
 * created EXCLUSIVELY.
 *
 * What is pinned is the promise the function exists for and what the
 * migration must not change: a new artifact is created with exactly the
 * body's UTF-8 bytes; anything already at the destination — a file, a
 * directory, a link to a file, a DANGLING link — is left exactly as it was and
 * reported as skipped, never opened, followed or written through; any other
 * failure of the write is rethrown as the very same error; and a failure to
 * make the parent rejects before any write is attempted.
 *
 * The two calls are observed with spies that forward to the real
 * `fs/promises`; a failure is planted by rejecting the next call once. The
 * write's options are asserted as they are actually passed:
 * `{ encoding: "utf-8", flag: "wx" }`. Before this function used the storage
 * helper it passed `"utf8"`; the two names are one encoding to Node, so the
 * bytes are the same, and the first case checks those bytes directly. Every
 * arrangement and every check of the result uses the synchronous `node:fs`
 * API, which is not spied on.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "bun:test";

const spies = (() => ({ mkdir: vi.fn(), writeFile: vi.fn() }))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const disk = (realFsPromises as typeof import("fs/promises"));
  spies.mkdir.mockImplementation(disk.mkdir as never);
  spies.writeFile.mockImplementation(disk.writeFile as never);
  return { ...disk, mkdir: spies.mkdir, writeFile: spies.writeFile };
});

import { writeDerivedArtifact } from "../../src/viewer/navigation-write.js";

const ACCENTED = '{\n  "name": "Zoë — café ✓ 理"\n}\n';
const ARTIFACT = ".obsidian/graph.json";
const SKIPPED = { file: ARTIFACT, outcome: "skipped-existing" };

/** A fresh project directory with clean spies, removed when the test ends. */
function project(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "viewer-artifact-writes-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  spies.mkdir.mockClear();
  spies.writeFile.mockClear();
  return root;
}

/** A project whose artifact destination is already occupied by whatever `make` puts there. */
function occupied(make: (destination: string) => void): string {
  const root = project();
  mkdirSync(path.join(root, ".obsidian"));
  make(path.join(root, ARTIFACT));
  return root;
}

const coded = (code: string): Error => Object.assign(new Error(`planted ${code}`), { code });

describe("writeDerivedArtifact creates", () => {
  it("writes exactly the body's UTF-8 bytes under directories that did not exist", async () => {
    const root = project();
    expect(await writeDerivedArtifact(root, "wiki/maps/deep/map.canvas", ACCENTED)).toEqual({ file: "wiki/maps/deep/map.canvas", outcome: "created" });
    expect(readFileSync(path.join(root, "wiki/maps/deep/map.canvas")).equals(Buffer.from(ACCENTED, "utf8"))).toBe(true);
  });

  it("makes the parent first, then creates exclusively, with exactly these arguments", async () => {
    const root = project();
    await writeDerivedArtifact(root, ARTIFACT, ACCENTED);
    expect(spies.mkdir.mock.calls).toEqual([[path.join(root, ".obsidian"), { recursive: true }]]);
    expect(spies.writeFile.mock.calls).toEqual([[path.join(root, ARTIFACT), ACCENTED, { encoding: "utf-8", flag: "wx" }]]);
    expect(spies.mkdir.mock.invocationCallOrder[0]!).toBeLessThan(spies.writeFile.mock.invocationCallOrder[0]!);
  });
});

describe("writeDerivedArtifact never clobbers", () => {
  it("leaves an existing file exactly as it was", async () => {
    const root = occupied((destination) => writeFileSync(destination, "my own colours\n"));
    expect(await writeDerivedArtifact(root, ARTIFACT, ACCENTED)).toEqual(SKIPPED);
    expect(readFileSync(path.join(root, ARTIFACT), "utf8")).toBe("my own colours\n");
  });

  it("reports a directory at the destination as existing", async () => {
    const root = occupied((destination) => mkdirSync(destination));
    expect(await writeDerivedArtifact(root, ARTIFACT, ACCENTED)).toEqual(SKIPPED);
    expect(lstatSync(path.join(root, ARTIFACT)).isDirectory()).toBe(true);
  });

  it("does not write through a dangling link", async () => {
    const root = occupied((destination) => symlinkSync("no-such-target.json", destination));
    expect(await writeDerivedArtifact(root, ARTIFACT, ACCENTED)).toEqual(SKIPPED);
    expect(readlinkSync(path.join(root, ARTIFACT))).toBe("no-such-target.json");
    expect(() => lstatSync(path.join(root, ".obsidian/no-such-target.json"))).toThrow(/ENOENT/);
  });

  it("does not write through a link to an existing file", async () => {
    const root = occupied((destination) => symlinkSync("../elsewhere.json", destination));
    writeFileSync(path.join(root, "elsewhere.json"), "kept\n");
    expect(await writeDerivedArtifact(root, ARTIFACT, ACCENTED)).toEqual(SKIPPED);
    expect(readFileSync(path.join(root, "elsewhere.json"), "utf8")).toBe("kept\n");
    expect(lstatSync(path.join(root, ARTIFACT)).isSymbolicLink()).toBe(true);
  });
});

describe("writeDerivedArtifact failures", () => {
  it("rethrows any other write error, unchanged, and creates nothing", async () => {
    const root = project();
    const error = coded("EACCES");
    spies.writeFile.mockRejectedValueOnce(error);
    await expect(writeDerivedArtifact(root, ARTIFACT, ACCENTED)).rejects.toBe(error);
    expect(() => lstatSync(path.join(root, ARTIFACT))).toThrow(/ENOENT/);
  });

  it("rejects when the parent cannot be made, and never attempts the write", async () => {
    const root = project();
    writeFileSync(path.join(root, ".obsidian"), "a file where the directory should be");
    await expect(writeDerivedArtifact(root, ARTIFACT, ACCENTED)).rejects.toMatchObject({ code: "EEXIST" });
    const error = coded("EACCES");
    spies.mkdir.mockRejectedValueOnce(error);
    await expect(writeDerivedArtifact(root, "wiki/maps/map.canvas", ACCENTED)).rejects.toBe(error);
    expect(spies.mkdir).toHaveBeenCalledTimes(2);
    expect(spies.writeFile).not.toHaveBeenCalled();
  });
});
