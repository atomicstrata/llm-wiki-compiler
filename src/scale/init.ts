/**
 * @file src/scale/init.ts
 * @description Explicit project creation, optionally with an expected scale.
 *
 * Creation scaffolds only the confined private directory and `sources/`, then
 * PROVES the local setup is usable rather than writing a ready flag: both
 * directories must be real (no-follow) directories confined to the root, and
 * the gated project mutation lock must be acquirable and releasable — the same
 * lock every later mutation takes. With an estimate it then sets the expected
 * scale (and prepares it); a small estimate plans `local-standard`, which
 * writes only the record. Nothing registers or adopts the portable path,
 * starts a process, calls a provider or touches the network.
 *
 * Invalid input is refused before anything is created; a missing root is then
 * created like any project directory. Without an estimate no
 * scale record is written, so the project behaves exactly like one created
 * implicitly by a first ingest.
 */

import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { scaffoldConfinedDirectories } from "../utils/confined-scaffold.js";
import { LLMWIKI_DIR, SOURCES_DIR } from "../utils/constants.js";
import { releaseLock } from "../utils/lock.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import type { ScaleRequest } from "./contracts.js";
import { parseDocumentCount, parseSizeBytes, planScale } from "./plan.js";
import { scaleStatus, setExpectedScale, type ScaleReport } from "./transition.js";

/** What creation did and where the project now stands. */
export interface InitProjectResult {
  /** Directories this call created (project-relative). */
  readonly created: readonly string[];
  readonly report: ScaleReport;
}

/** Parse the CLI's textual estimate: size, documents or both; `undefined` when neither was given. */
export function parseExpectedScale(size: string | undefined, documents: string | undefined): ScaleRequest | undefined {
  if (size === undefined && documents === undefined) return undefined;
  return {
    ...(size === undefined ? {} : { sizeBytes: parseSizeBytes(size) }),
    ...(documents === undefined ? {} : { documents: parseDocumentCount(documents) }),
  };
}

/** Refuse unless `relDir` under `root` is a real directory, not a link. */
async function assertRealDirectory(root: string, relDir: string): Promise<void> {
  const info = await lstat(path.join(root, relDir));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`init: ${relDir} is not a real directory`);
}

/** Prove the local setup is usable: confined real directories and a working project lock. */
async function verifyLocalSetup(root: string): Promise<void> {
  if ((await resolveExistingConfinedPrivateDir(root)) === null) throw new Error("init: the private directory is missing after creation");
  await assertRealDirectory(root, SOURCES_DIR);
  await acquireMutationLockBlocking(root, "scale");
  await releaseLock(root);
}

/** Create (or re-verify) the project at `root`, then set `expected` when given. */
export async function initProject(root: string, expected?: ScaleRequest): Promise<InitProjectResult> {
  if (expected !== undefined) planScale(expected);
  // The root itself is the confinement boundary: establish it first, then confine everything beneath it.
  await mkdir(root, { recursive: true });
  const { created } = await scaffoldConfinedDirectories(root, [LLMWIKI_DIR, SOURCES_DIR]);
  await verifyLocalSetup(root);
  const report = expected === undefined ? await scaleStatus(root) : await setExpectedScale(root, { request: expected });
  return { created, report };
}
