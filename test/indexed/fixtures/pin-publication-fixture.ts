/**
 * @file test/indexed/fixtures/pin-publication-fixture.ts
 * @description Private, writer-shaped fixtures for EXPLICIT UNPIN recovery
 * (IDX-1, slice 3): an active `local-indexed` project whose pins were written
 * by the REAL `catalogPin`, and the interrupted publication states the
 * create-only writer can leave in a pin label.
 *
 * The template holds two durable done batch runs, a constructed schema-valid
 * compile-state meta committed through the real store, an active
 * `local-indexed` V2 record, and two real pins: `keep` (the subject) and
 * `other` (a bystander every case must leave exactly as it was). Each case
 * copies the template without its reader-lease registry.
 *
 * Interrupted states are made from the GENUINE published bytes by renaming or
 * hard-linking only the writer's own names: W = `<target>.writing`, R =
 * `<target>.tmp`, F = `<target>`, so W+R and R+F share one inode with two links,
 * exactly as the publisher leaves them. Two targets exist: the index
 * `pin.json` (every copy already settled) and the LAST copy in the writer's
 * sorted order, with no index name at all (the copy was in flight). No state
 * is synthesized from scratch, and no fixture asserts what the writer would do.
 *
 * LABELLED SEAM: `serializeOwner` (own-PID owner record) for the raw lock the
 * real pin writer and every unpin acquire.
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, readdirSync, renameSync } from "node:fs";
import { chmod, link, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCompileState } from "../../../src/cstate/store.js";
import { catalogPin } from "../../../src/indexed/maintenance.js";
import { SCALE_RECORD_FILE } from "../../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecordV2 } from "../../../src/scale/contracts-v2.js";
import { serializeAnyScaleRecord } from "../../../src/scale/record-v2-schema.js";
import { newScratchBatchRun } from "../../batch/scratch-run.js";
import { copyProjectTemplate, privateRoots, withOwnPidOwnerSeam } from "../../fixtures/scoped-test-roots.js";

export const PINS = ".llmwiki/indexed-pins";
export const SUBJECT = "keep";
export const BYSTANDER = "other";
export const INDEX = "pin.json";
/** One writer state of a target: which of its names exist (linked when two). */
export type WriterState = "W" | "WR" | "R" | "RF";
export const WRITER_STATES: readonly WriterState[] = ["W", "WR", "R", "RF"];
/** The active `local-indexed` record every fixture starts from. */
export const ACTIVE_INDEXED: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 1, requested: { documents: 100, sizeBytes: 102400, documentsBasis: "stated", sizeBasis: "stated" }, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };
const COMPILE_STATE_META = { schema: 1, version: 2, indexHash: "fixture", promptModifiers: null, frozenPresent: false, sources: 0, owners: 0, frozen: 0, nextOrdinal: 0, lastRun: null, legacy: { relPath: ".llmwiki/state.json", stamp: null, records: 0, bytes: 0, sha256: null } };
const fixtureRoots = privateRoots("llmwiki-unpin-recovery-");

/** A new private directory, removed by {@link removeFixtureRoots}. */
export const privateDir = (): Promise<string> => fixtureRoots.privateDir();

/** Remove every fixture directory made so far. */
export const removeFixtureRoots = (): Promise<void> => fixtureRoots.cleanup();

/** Run `body` with the own-PID `serializeOwner` seam, restored afterwards. */
export const withOwnerSeam = <T>(body: () => Promise<T>): Promise<T> => withOwnPidOwnerSeam(body);

/** Build the template: two done runs, a compile state, the active record, then the real pins `keep` and `other`. */
export function buildPinTemplate(): Promise<string> {
  return withOwnerSeam(async () => {
    const template = await privateDir();
    for (let at = 0; at < 2; at++) await (await newScratchBatchRun(template)).advance("done");
    await (await openCompileState(template)).commit({ meta: COMPILE_STATE_META });
    await writeFile(path.join(template, SCALE_RECORD_FILE), serializeAnyScaleRecord(ACTIVE_INDEXED));
    await catalogPin(template, SUBJECT);
    await catalogPin(template, BYSTANDER);
    return template;
  });
}

/** A copy of `template` this process never registered on. */
export const pinProject = (template: string): Promise<string> => copyProjectTemplate(template, privateDir);

/** A same-named copy of label directory `from` at `to`: new inodes, same bytes, every leaf private (0600). */
export function cloneLabelDir(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  for (const name of readdirSync(to)) chmodSync(path.join(to, name), 0o600);
}

/** Swap the directories at `a` and `b` through `spare` (three renames; no file inside either changes). */
export function swapDirs(a: string, b: string, spare: string): void {
  renameSync(a, spare);
  renameSync(b, a);
  renameSync(spare, b);
}

/** The absolute directory of pin `label`. */
export const labelDir = (root: string, label = SUBJECT): string => path.join(root, PINS, label);

/** The settled copy names of `label` in the writer's (sorted store) order. */
export async function copyNames(root: string, label = SUBJECT): Promise<string[]> {
  return (await readdir(labelDir(root, label))).filter((name) => name.endsWith(".manifest")).sort();
}

/** Turn settled `final` (in `dir`) into writer state `state`, using only its own names and links. */
export async function interrupt(dir: string, final: string, state: WriterState): Promise<void> {
  const [w, r, f] = [`${final}.writing`, `${final}.tmp`, final].map((name) => path.join(dir, name));
  if (state === "RF") return link(f, r);
  await rename(f, state.startsWith("W") ? w : r);
  if (state === "WR") await link(w, r);
}

/** Interrupt the subject's INDEX publication: every copy settled, `pin.json` in `state`. */
export async function interruptIndex(root: string, state: WriterState): Promise<void> {
  await interrupt(labelDir(root), INDEX, state);
}

/** Interrupt the subject's LAST copy before any index: `pin.json` removed, the last copy in `state`. */
export async function interruptLastCopy(root: string, state: WriterState): Promise<string> {
  const last = (await copyNames(root)).at(-1)!;
  await rm(path.join(labelDir(root), INDEX));
  await interrupt(labelDir(root), last, state);
  return last;
}

/** Write `bytes` as a new private (0600) single-link leaf at `file`. */
export async function writePrivate(file: string, bytes: Buffer | string): Promise<void> {
  await writeFile(file, bytes);
  await chmod(file, 0o600);
}

/** dev:ino:mode:nlink:sha256 of every entry under the pins and indexed trees ("dir" for directories): what a refusal keeps. */
export async function dataState(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const top of [PINS, ".llmwiki/indexed"]) {
    for (const name of await readdir(path.join(root, top), { recursive: true }).catch(() => [] as string[])) {
      const file = path.join(root, top, name);
      const info = await lstat(file, { bigint: true });
      const body = info.isFile() ? createHash("sha256").update(await readFile(file)).digest("hex") : info.isSymbolicLink() ? "symlink" : "dir";
      state[`${top}/${name}`] = `${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${body}`;
    }
  }
  return state;
}

/** The entries of `state` under pin `label`. */
export function labelEntries(state: Record<string, string>, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(state).filter(([name]) => name === `${PINS}/${label}` || name.startsWith(`${PINS}/${label}/`)));
}

/** The entries of `state` outside pin `label` (the bystander pin and every store). */
export function outsideLabel(state: Record<string, string>, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(state).filter(([name]) => !(name === `${PINS}/${label}` || name.startsWith(`${PINS}/${label}/`))));
}

/** The refusal code of `work`, or `accepted`. */
export function codeOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));
}
