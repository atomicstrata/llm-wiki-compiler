/**
 * @file test/storage/project-tree.ts
 * @description The single-project scaffolding the compile and lock binding suites
 * share. Each suite mints ONE real project, runs its scenario by root on disk, and
 * compares what the disk printed and left behind with the same scenario over
 * memory doubles.
 *
 * - {@link mintSingle}: mint the one project once, before the suite, through the
 *   shared once-then-remove hooks; {@link mintSeededBeforeAsk} for one seeded with
 *   files and asked by a writing consumer.
 * - {@link captureStatusLines}: the status lines a scenario prints, ANSI-stripped.
 * - {@link diskLeaves} / {@link diskTree} / {@link sortedTree}: the project's
 *   leaves (all, or under one directory) as text or as the suite renders their
 *   bytes, by project-relative path, in sorted order.
 * - {@link expectHoldsExactly}: a copy's files are LITERALLY the seed.
 * - {@link expectBoundSilentThenFreshRoot}: the zero-ambient half of a bound-vs-root
 *   witness, then a freshly seeded root for the suite's own root-route assertions.
 *
 * Only the scaffolding is shared. Every suite keeps its own scenario, its own
 * view of the tree (which leaves it shows, and how), and its own assertions.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "bun:test";
import * as output from "../../src/utils/output.js";
import type { TempRootTrackerV1 } from "../temp-roots.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";

/**
 * Mint the suite's one project once, before any test, through the shared
 * once-then-remove hooks registered where this is called. The returned record
 * is filled in when the minting runs.
 *
 * @param tracker - The suite's tracker, which the suite may keep using for its own roots.
 * @param mint - Mints the project.
 */
export function mintSingle<Answer>(tracker: TempRootTrackerV1, mint: () => Promise<Minted<Answer>>): Minted<Answer> {
  const minted = {} as Minted<Answer>;
  mintOnceThenRemove(tracker, async () => { Object.assign(minted, await mint()); });
  return minted;
}

/** {@link mintSingle} of one project seeded with `files`, its copy taken BEFORE the (writing) disk `ask`. */
export function mintSeededBeforeAsk<Answer>(
  tracker: TempRootTrackerV1, prefix: string, files: Record<string, string>, ask: (root: string) => Promise<Answer>,
): Minted<Answer> {
  return mintSingle(tracker, () => mintCopiedBeforeAsk(tracker, prefix, (root) => writeFiles(root, files), ask));
}

/** `message` without its ANSI colour codes. */
export const plain = (message: string): string => message.replace(/\u001b\[[0-9;]*m/gu, "");

/** Record every status line into `lines` as `icon text`, the text ANSI-stripped and then passed through `shown`; returns the spy to restore. */
export const captureStatusLines = (lines: string[], shown: (text: string) => string = (text) => text) =>
  vi.spyOn(output, "status").mockImplementation((icon, message) => { lines.push(`${icon} ${shown(plain(message))}`); });

/** Require LITERALLY that `files` holds exactly `seed`: the same paths, each with its seeded text. */
export function expectHoldsExactly(files: ReadonlyMap<string, string>, seed: Readonly<Record<string, string>>): void {
  const paths = Object.keys(seed).sort();
  expect([[...files.keys()].sort(), paths.map((rel) => files.get(rel))]).toEqual([paths, paths.map((rel) => seed[rel])]);
}

/**
 * Run the bound route and require that it reached NONE of `spies`; then mint a
 * fresh root under `fresh.prefix`, seed it, and return it so the suite asserts
 * its own root route inline.
 */
export async function expectBoundSilentThenFreshRoot(
  spies: ReadonlyArray<{ mock: { calls: unknown[] } }>, bound: () => Promise<unknown>,
  fresh: { tracker: TempRootTrackerV1; prefix: string; seed: (root: string) => Promise<void> },
): Promise<string> {
  await bound();
  expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
  const root = await fresh.tracker.create(fresh.prefix);
  await fresh.seed(root);
  return root;
}

/** `held` with its paths in sorted order. */
export const sortedTree = (held: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(held).sort(([a], [b]) => a.localeCompare(b)));

/** Which non-directory entries a tree holds, by project-relative path. */
export type KeepLeaf = (rel: string, entry: Dirent) => boolean;
/** Regular files only. */
export const regularFiles: KeepLeaf = (_rel, entry) => entry.isFile();
/** Every non-directory entry, read through to its target. */
export const everyLeaf: KeepLeaf = () => true;

/** Which part of the tree a walk reads, which leaves it keeps, and how it renders a kept leaf's bytes. */
interface LeafWalk { rel?: string; keep?: KeepLeaf; show?: (bytes: Buffer) => string }

/** A leaf's bytes as UTF-8 text. */
const utf8Text = (bytes: Buffer): string => bytes.toString("utf-8");

/**
 * Every kept leaf under `walk.rel` (the whole project by default), each rendered
 * by `walk.show` (UTF-8 text by default), by project-relative POSIX path, sorted.
 * Directories are walked, never kept; by default every other entry is kept.
 */
export async function diskLeaves(root: string, walk: LeafWalk = {}, held: Record<string, string> = {}): Promise<Record<string, string>> {
  const { rel = "", keep = everyLeaf, show = utf8Text } = walk;
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await diskLeaves(root, { ...walk, rel: child }, held);
    else if (keep(child, entry)) held[child] = show(await readFile(path.join(root, child)));
  }
  return sortedTree(held);
}

/** Every leaf `keep` admits under `root` as UTF-8 text, by project-relative POSIX path, sorted. */
export const diskTree = (root: string, keep: KeepLeaf): Promise<Record<string, string>> => diskLeaves(root, { keep });
