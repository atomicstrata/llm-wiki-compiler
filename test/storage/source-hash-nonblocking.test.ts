/**
 * @file test/storage/source-hash-nonblocking.test.ts
 * @description Public #280 parity through the storage bindings: sources are
 * hashed WITHOUT blocking on a named pipe, on every path that hashes them.
 *
 * Public `hashFile` opens non-blocking and rejects anything that is not a
 * regular file with `NotRegularFileError`; public freshness treats such a
 * source as not there. Here the same contract is pinned where the bindings
 * moved the reads: the disk leaf (`readRegularLocationText`), the local compile
 * access (`diskCompileAccess(root).hashSource`), root change detection
 * (`detectChanges`), and the freshness decision body over a supplied,
 * non-disk `SourceFreshnessSources`. A blocking read of a pipe nothing writes
 * would hang until the test timed out, so a pass is the absence of a hang.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { diskCompileAccess } from "../../src/compiler/compile-access.js";
import { detectChanges, hashFile, NotRegularFileError } from "../../src/compiler/hasher.js";
import { buildFreshnessSnapshotFrom, type SourceFreshnessSources } from "../../src/freshness/index.js";
import { readRegularLocationText } from "../../src/storage/disk-locations.js";
import type { WikiState } from "../../src/utils/types.js";

const POSIX = process.platform !== "win32";
const TEXT = "# Tides\n\nTides make electricity. Zoë ✓\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

let root = "";
const at = (relative: string): string => path.join(root, relative);

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "source-hash-nonblocking-")));
  await mkdir(at("sources"), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the disk leaf reads a regular file only, without blocking", () => {
  it("returns a regular file's whole UTF-8 text", async () => {
    await writeFile(at("sources/a.md"), TEXT);
    expect(await readRegularLocationText(at("sources/a.md"))).toBe(TEXT);
  });

  it.skipIf(!POSIX)("rejects a named pipe with NotRegularFileError instead of waiting on it", async () => {
    execFileSync("mkfifo", [at("sources/pipe.md")]);
    await expect(readRegularLocationText(at("sources/pipe.md"))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it("rejects a directory with NotRegularFileError and reports nothing there as ENOENT", async () => {
    await mkdir(at("sources/folder.md"));
    await expect(readRegularLocationText(at("sources/folder.md"))).rejects.toBeInstanceOf(NotRegularFileError);
    await expect(readRegularLocationText(at("sources/absent.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("the local compile hashes sources like hashFile", () => {
  it("hashes a regular source to the same digest as hashFile", async () => {
    await writeFile(at("sources/a.md"), TEXT);
    const hashed = await diskCompileAccess(root).hashSource("a.md");
    expect([hashed, await hashFile(at("sources/a.md"))]).toEqual([sha256(TEXT), sha256(TEXT)]);
  });

  it.skipIf(!POSIX)("rejects a source replaced by a named pipe instead of hanging the compile", async () => {
    execFileSync("mkfifo", [at("sources/pipe.md")]);
    await expect(diskCompileAccess(root).hashSource("pipe.md")).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it.skipIf(!POSIX)("detects changes over regular sources and never opens a pipe among them", async () => {
    await writeFile(at("sources/a.md"), TEXT);
    execFileSync("mkfifo", [at("sources/pipe.md")]);
    const previous: WikiState = { version: 1, indexHash: "", sources: {} };
    for (const changes of [await detectChanges(root, previous), await diskCompileAccess(root).detectChanges(previous)]) {
      expect(changes).toEqual([{ file: "a.md", status: "new" }]);
    }
  });
});

describe("the freshness body treats an unreadable-as-text source as not there", () => {
  /** Sources that place every key and answer `null` (not a regular file) for one of them. */
  function memorySources(texts: Record<string, string | null>, reads: string[]): SourceFreshnessSources {
    return {
      openSources: async () => ({
        resolveSource: async (file) => (file in texts ? file : null),
        readText: async (source) => { reads.push(source); return texts[source]; },
      }),
    };
  }

  it("classifies a null read as exists:false and still hashes the regular source after it", async () => {
    const reads: string[] = [];
    const entry = (hash: string) => ({ hash, concepts: ["topic"], compiledAt: "t" });
    const state: WikiState = { version: 1, indexHash: "", sources: { "pipe.md": entry("RECORDED"), "a.md": entry(sha256(TEXT)) } };
    const snapshot = await buildFreshnessSnapshotFrom(memorySources({ "pipe.md": null, "a.md": TEXT }, reads), { status: "ok", state });
    expect(snapshot.sources).toEqual({
      "pipe.md": { recordedHash: "RECORDED", currentHash: null, exists: false, concepts: ["topic"] },
      "a.md": { recordedHash: sha256(TEXT), currentHash: sha256(TEXT), exists: true, concepts: ["topic"] },
    });
    expect(reads).toEqual(["pipe.md", "a.md"]);
  });
});
