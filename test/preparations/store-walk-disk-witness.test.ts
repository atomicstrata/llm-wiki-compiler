/**
 * @file test/preparations/store-walk-disk-witness.test.ts
 * @description A DISK WITNESS for the preparation store scanner's two ROOT
 * FORMS, `scanActivePreparationStore(root)` and `scanPreparationOrphans(root)`,
 * on small real trees. It asserts what each returns: every leaf record, every
 * problem with its exact words and project-relative path, the identity lists
 * and the entry count.
 *
 * WHY IT EXISTS. It uses only the root forms, so the same bytes run before and
 * after the scanner's walk was moved onto its own reads. Its job is to show the
 * strings and records did not change, most of all the project-relative PATHS,
 * and to execute `scanPreparationOrphans`, which no other test calls.
 *
 * WHAT LISTING ORDER ALLOWS. A directory's entries come in the filesystem's
 * order, so leaves and problems are compared SORTED, with two exceptions that
 * are stable and are asserted unsorted: in the combined form every `workspaces`
 * leaf precedes every quarantine leaf, and the entry-bound case uses a tree in
 * which every directory holds exactly one entry, so which directory refuses
 * does not depend on order.
 *
 * SIZE AND IDENTITY are compared with an independent `lstat` of the same leaf.
 *
 * WHAT THIS DOES NOT SHOW. Two refusals cannot be produced on demand on a real
 * disk and are NOT executed here: a directory that passes its checks and then
 * cannot be listed, and a leaf that vanishes between listing and opening
 * ("preparation leaf is absent"). It shows nothing about the lifecycle proof,
 * the key, authentication or any run's contents: the leaves here are arbitrary
 * bytes, classified by path alone.
 *
 * THE ONLY THING THIS FILE EVER REMOVES is a directory it created itself with
 * `mkdtemp`. Before removing, it checks the path sits directly inside the
 * operating system's temporary directory and carries this file's own prefix.
 */

import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  scanActivePreparationStore, scanPreparationOrphans, type PreparationLeafObservation,
} from "../../src/preparations/orphan-scan.js";
import {
  EVIDENCE_SEGMENT, MANIFEST_FILENAME, PREPARATIONS_SEGMENT, PREPARATION_QUARANTINE_SEGMENT, PREPARATION_RUNS_SEGMENT,
} from "../../src/preparations/paths.js";

const OWN_PREFIX = "preparation-store-walk-witness-";
const WORKSPACE = "research";
const PREPARATION = `prp_${"a".repeat(32)}`;
const RUN = `prr_${"b".repeat(32)}`;
const LINKED_RUN = `prr_${"c".repeat(32)}`;
const EVIDENCE = "d".repeat(64);
const PARTITION = "reset-1";

const WORKSPACE_DIR = path.join("workspaces", WORKSPACE);
const PREPARATION_DIR = path.join(WORKSPACE_DIR, PREPARATIONS_SEGMENT, PREPARATION);
const RUNS_DIR = path.join(WORKSPACE_DIR, PREPARATION_RUNS_SEGMENT);
const MANIFEST = path.join(PREPARATION_DIR, MANIFEST_FILENAME);
const EVIDENCE_LEAF = path.join(PREPARATION_DIR, EVIDENCE_SEGMENT, EVIDENCE);
const EVIDENCE_ALIAS = `${EVIDENCE_LEAF}.tmp`;
const STRAY = path.join(PREPARATION_DIR, "stray.txt");
const RUN_LEAF = path.join(RUNS_DIR, `${RUN}.json`);
const CANCEL_LEAF = path.join(RUNS_DIR, `${RUN}.cancel`);
const LINKED_LEAF = path.join(RUNS_DIR, `${LINKED_RUN}.json`);
const FOREIGN_LEAF = path.join(WORKSPACE_DIR, "operations", "bundle.json");
const QUARANTINE_LEAF = path.join(PREPARATION_QUARANTINE_SEGMENT, PARTITION, "held.json");

/** Entries the active walk takes in the full tree: 1 + 3 + 1 + 3 + 2 + 3, one line per directory below. */
const ACTIVE_ENTRIES = 13;
/** The quarantine walk takes two more: the partition, then its leaf. */
const COMBINED_ENTRIES = ACTIVE_ENTRIES + 2;

const created: string[] = [];

/** A fresh directory of this file's own, remembered for removal. */
async function ownDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), OWN_PREFIX));
  created.push(dir);
  return dir;
}

/** Remove ONLY a directory this file created: directly inside the OS temporary directory, with this file's prefix. */
async function removeOwnDirectory(dir: string): Promise<void> {
  const insideOsTemp = path.dirname(await realpath(dir)) === await realpath(os.tmpdir());
  if (!insideOsTemp || !path.basename(dir).startsWith(OWN_PREFIX)) {
    throw new Error(`refusing to remove a directory this test did not create: ${dir}`);
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  for (const dir of created.splice(0)) await removeOwnDirectory(dir);
});

/** Write one store leaf, by its path relative to `.llmwiki`, with `bytes` bytes. */
async function writeLeaf(root: string, relative: string, bytes: number): Promise<void> {
  const file = path.join(root, ".llmwiki", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x".repeat(bytes), "utf8");
}

/**
 * The full tree. `workspaces` holds 1 entry; the workspace 3 (preparations,
 * runs, a foreign directory); preparations 1; the preparation 3 (manifest,
 * evidence directory, a stray leaf); evidence 2; runs 3 (run, cancel, a link).
 */
async function fullTree(): Promise<string> {
  const root = await ownDirectory();
  await writeLeaf(root, MANIFEST, 11);
  await writeLeaf(root, EVIDENCE_LEAF, 12);
  await writeLeaf(root, EVIDENCE_ALIAS, 13);
  await writeLeaf(root, STRAY, 14);
  await writeLeaf(root, RUN_LEAF, 15);
  await writeLeaf(root, CANCEL_LEAF, 16);
  await writeLeaf(root, FOREIGN_LEAF, 17);
  await writeLeaf(root, QUARANTINE_LEAF, 18);
  await writeFile(path.join(root, "outside.json"), "{}", "utf8");
  await symlink(path.join(root, "outside.json"), path.join(root, ".llmwiki", LINKED_LEAF));
  return root;
}

/** The record the scanner must produce for one leaf, with size and identity from an independent `lstat`. */
async function expectedLeaf(
  root: string, relativePath: string, fields: Partial<PreparationLeafObservation>,
): Promise<PreparationLeafObservation> {
  const stats = await lstat(path.join(root, ".llmwiki", relativePath));
  return {
    relativePath, logicalRelativePath: relativePath, kind: "unknown",
    bytes: stats.size, dev: stats.dev, ino: stats.ino, ...fields,
  };
}

/** The six active leaves of the full tree, sorted by path. */
async function expectedActiveLeaves(root: string): Promise<PreparationLeafObservation[]> {
  const preparation = { workspaceId: WORKSPACE, preparationId: PREPARATION };
  const run = { workspaceId: WORKSPACE, runId: RUN };
  const leaves = await Promise.all([
    expectedLeaf(root, MANIFEST, { kind: "manifest", ...preparation }),
    expectedLeaf(root, EVIDENCE_LEAF, { kind: "evidence", ...preparation }),
    expectedLeaf(root, EVIDENCE_ALIAS, {
      kind: "evidence", ...preparation, protocolAlias: "tmp", logicalRelativePath: EVIDENCE_LEAF,
    }),
    expectedLeaf(root, STRAY, { kind: "unknown", ...preparation }),
    expectedLeaf(root, RUN_LEAF, { kind: "run", ...run }),
    expectedLeaf(root, CANCEL_LEAF, { kind: "cancel", ...run }),
  ]);
  return sortedByPath(leaves);
}

/** The two problems of the full tree's active walk, sorted by path. */
const ACTIVE_PROBLEMS = [
  { dimension: "preparation-entry", detail: "unknown preparation leaf", path: path.join(".llmwiki", STRAY) },
  { dimension: "leaf-unavailable", detail: "preparation leaf is unavailable", path: path.join(".llmwiki", LINKED_LEAF) },
].sort((left, right) => left.path.localeCompare(right.path));

/** A copy sorted by the one field every leaf and problem here carries. */
function sortedByPath<T extends { relativePath?: string; path?: string }>(items: readonly T[]): T[] {
  const key = (item: T): string => item.relativePath ?? item.path ?? "";
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}

describe("preparation store walk on the local disk: the active root form", () => {
  it("D1 records every active leaf with its lstat size and identity, and words both problems exactly", async () => {
    const root = await fullTree();
    const scan = await scanActivePreparationStore(root);
    expect(sortedByPath(scan.leaves)).toEqual(await expectedActiveLeaves(root));
    expect(sortedByPath(scan.problems)).toEqual(ACTIVE_PROBLEMS);
    expect(scan.workspaces).toEqual([WORKSPACE]);
    expect(scan.preparationDirectories).toEqual([{ workspaceId: WORKSPACE, preparationId: PREPARATION }]);
    expect(scan.traversalEntries).toBe(ACTIVE_ENTRIES);
  });
});

describe("preparation store walk on the local disk: the combined root form", () => {
  it("D2 adds the quarantine leaf AFTER every workspaces leaf, with the same active records and problems", async () => {
    const root = await fullTree();
    const scan = await scanPreparationOrphans(root);
    const quarantine = await expectedLeaf(root, QUARANTINE_LEAF, { kind: "quarantine" });
    expect(scan.leaves.at(-1)).toEqual(quarantine);
    expect(scan.leaves.slice(0, -1).every((leaf) => leaf.relativePath.startsWith("workspaces"))).toBe(true);
    expect(sortedByPath(scan.leaves.slice(0, -1))).toEqual(await expectedActiveLeaves(root));
    expect(sortedByPath(scan.problems)).toEqual(ACTIVE_PROBLEMS);
    expect(scan.traversalEntries).toBe(COMBINED_ENTRIES);
  });
});

describe("preparation store walk on the local disk: the entry bound, on a one-entry-per-directory tree", () => {
  it("D3 a limit equal to the entries is clean; one fewer refuses in the last directory, exactly once", async () => {
    const root = await ownDirectory();
    await writeLeaf(root, MANIFEST, 11);
    const exact = await scanActivePreparationStore(root, { maxDirectoryEntriesForTest: 4 });
    expect(exact.problems).toEqual([]);
    expect(exact.traversalEntries).toBe(4);
    expect(exact.leaves).toEqual([await expectedLeaf(root, MANIFEST, {
      kind: "manifest", workspaceId: WORKSPACE, preparationId: PREPARATION,
    })]);
    const bounded = await scanActivePreparationStore(root, { maxDirectoryEntriesForTest: 3 });
    expect(bounded.problems).toEqual([{
      dimension: "directory-entries", detail: "preparation inventory entry bound exceeded",
      path: path.join(".llmwiki", PREPARATION_DIR),
    }]);
    expect(bounded.traversalEntries).toBe(4);
    expect(bounded.leaves).toEqual([]);
  });
});

describe("preparation store walk on the local disk: refusals before any entry", () => {
  it("D4 a walk root that is not a directory is one unavailable-directory problem, with its path", async () => {
    const root = await ownDirectory();
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(path.join(root, ".llmwiki", "workspaces"), "not a directory", "utf8");
    const scan = await scanActivePreparationStore(root);
    expect(scan.problems).toEqual([{
      dimension: "directory-unavailable", detail: "preparation directory is unavailable",
      path: path.join(".llmwiki", "workspaces"),
    }]);
    expect([scan.leaves, scan.workspaces, scan.traversalEntries]).toEqual([[], [], 0]);
  });

  it("D5 an absent store is an empty result with no problem, through both root forms", async () => {
    const root = await ownDirectory();
    const empty = { leaves: [], workspaces: [], preparationDirectories: [], problems: [], traversalEntries: 0 };
    expect(await scanActivePreparationStore(root)).toEqual(empty);
    expect(await scanPreparationOrphans(root)).toEqual(empty);
  });
});
