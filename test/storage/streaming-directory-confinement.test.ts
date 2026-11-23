/**
 * @file test/storage/streaming-directory-confinement.test.ts
 * @description Witnesses of the confinement `diskStreamingDirectory` promises:
 * a listing stays inside the verified directory. A valid nested path lists
 * its entries; a `..` path to an existing sibling, an absolute path and an
 * anchor replaced by a link before iteration are each refused. Each refusal
 * case keeps the names yielded before the rejection separately from the
 * error and asserts that none was observed. The re-check happens immediately before
 * a directory is opened; these witnesses do not claim a race-free traversal.
 */

import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { diskStreamingDirectory, type StreamingLocalDirectory } from "../../src/storage/disk-local-reads.js";

const OUTSIDE_SENTINEL = "outside-sentinel.md";

/** What one listing did: every name it yielded before it ended, and the error it rejected with, if any. */
interface ListingOutcome { names: string[]; error: Error | null }

/**
 * Drain one listing. Names yielded before a rejection are kept, not
 * discarded, so a refusal case can show that nothing outside was observed.
 */
async function listingOf(directory: StreamingLocalDirectory, relative: string): Promise<ListingOutcome> {
  const names: string[] = [];
  try {
    for await (const entry of directory.entries(relative)) names.push(entry.name);
  } catch (error) {
    return { names: names.sort(), error: error as Error };
  }
  return { names: names.sort(), error: null };
}

/** Assert a refusal: the expected error, and no name at all observed before it. */
function expectRefusedUnobserved(outcome: ListingOutcome, message: RegExp): void {
  expect(outcome.error).toBeInstanceOf(Error);
  expect(String(outcome.error)).toMatch(message);
  expect(outcome.names).not.toContain(OUTSIDE_SENTINEL);
  expect(outcome.names).toEqual([]);
}

describe("the streaming directory listing stays inside its verified directory", () => {
  let root: string;
  let directory: StreamingLocalDirectory;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "streaming-dir-")));
    await mkdir(path.join(root, "wiki", "nested"), { recursive: true });
    await mkdir(path.join(root, "sibling"), { recursive: true });
    await writeFile(path.join(root, "wiki", "top.md"), "top");
    await writeFile(path.join(root, "wiki", "nested", "inner.md"), "inner");
    await writeFile(path.join(root, "sibling", OUTSIDE_SENTINEL), "outside");
    directory = (await diskStreamingDirectory(root, "wiki"))!;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("lists the directory itself and a valid nested path", async () => {
    expect(await listingOf(directory, "")).toEqual({ names: ["nested", "top.md"], error: null });
    expect(await listingOf(directory, "nested")).toEqual({ names: ["inner.md"], error: null });
  });

  it.each(["../sibling", "nested/../../sibling", ".."])("refuses the parent path %s without observing what is outside", async (relative) => {
    expectRefusedUnobserved(await listingOf(directory, relative), /not a path beneath the listed directory/u);
  });

  it("refuses an absolute path, even one that names an existing directory", async () => {
    expectRefusedUnobserved(await listingOf(directory, path.join(root, "sibling")), /not a path beneath the listed directory/u);
  });

  it("refuses the anchor when it was replaced by a link before iteration", async () => {
    await rename(path.join(root, "wiki"), path.join(root, "wiki-moved"));
    await symlink(path.join(root, "sibling"), path.join(root, "wiki"));
    expectRefusedUnobserved(await listingOf(directory, ""), /no longer a real directory/u);
  });

  it("refuses a nested directory that was replaced by a link before iteration", async () => {
    await rm(path.join(root, "wiki", "nested"), { recursive: true });
    await symlink(path.join(root, "sibling"), path.join(root, "wiki", "nested"));
    expectRefusedUnobserved(await listingOf(directory, "nested"), /no longer a real directory/u);
  });
});
