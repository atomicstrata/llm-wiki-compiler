/**
 * @file test/segments/barrier-publication-fixture.ts
 * @description Interrupted retirement-barrier publications for the IDX-1
 * barrier tests: the exact bytes `publishRetireBarrier` writes (writer field
 * order, `serializeOwner` owner shapes) planted in each state the create-only
 * writer can leave behind (W `.writing`, W+R `.tmp` as a second link, R, R+F),
 * plus malformed variants, and a full-width snapshot of the three reserved
 * names so a test can prove nothing was touched.
 *
 * OWNERS. `STALE_OWNER` names a pid no macOS process can have (above the
 * kernel's pid limit), so signal 0 fails ESRCH: a positive, real staleness
 * observation. `UNCERTAIN_OWNER` is this live process with no recorded start
 * identity (present, unidentifiable); `DENIED_OWNER` is pid 1, which signal 0
 * answers EPERM. Neither of the last two may ever authorize a discard.
 */

import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { SCALE_POLICY_V2, type ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";

/** The barrier's final name and its two reserved siblings, relative to the project. */
export const BARRIER_NAMES = { F: ".llmwiki/indexed-retire.json", R: ".llmwiki/indexed-retire.json.tmp", W: ".llmwiki/indexed-retire.json.writing" } as const;
/** A pid above the macOS pid limit: signal 0 fails ESRCH. */
export const STALE_OWNER = { pid: 999_999 };
/** This live process without a recorded start identity: present but not identifiable. */
export const UNCERTAIN_OWNER = { pid: process.pid };
/** Pid 1: signal 0 is denied (EPERM), which proves nothing about staleness. */
export const DENIED_OWNER = { pid: 1 };
/** The state names the writer can leave, and the malformed layouts the tests also plant. */
export type PlantedState = "W" | "WR" | "R" | "RF" | "FW" | "RF-foreign-inode" | "RF-third-link";

/** This host's barrier tag (as the barrier module computes it). */
export function hostTag(): string {
  return createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
}

/** A barrier exactly as `publishRetireBarrier` serializes it for `owner`. */
export function barrierBytes(owner: Record<string, unknown>, options: { planDigest?: string; host?: string } = {}): string {
  return `${JSON.stringify({ format: "llmwiki-indexed-retire-barrier", version: 1, token: "0".repeat(32), planDigest: options.planDigest ?? "e".repeat(64), host: options.host ?? hostTag(), owner })}\n`;
}

/** Write `bytes` at project-relative `name` with `mode`. */
async function writeLeaf(root: string, name: string, bytes: string, mode: number): Promise<void> {
  await writeFile(path.join(root, name), bytes);
  await chmod(path.join(root, name), mode);
}

/** Plant `bytes` in `state` under `root` (mode 0600 unless `mode` says otherwise). */
export async function plantBarrier(root: string, state: PlantedState, bytes: string, mode = 0o600): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  const at = (name: keyof typeof BARRIER_NAMES) => path.join(root, BARRIER_NAMES[name]);
  const first: keyof typeof BARRIER_NAMES = state.startsWith("W") ? "W" : state.startsWith("F") ? "F" : "R";
  await writeLeaf(root, BARRIER_NAMES[first], bytes, mode);
  if (state === "WR") await link(at("W"), at("R"));
  if (state === "RF" || state === "RF-third-link") await link(at("R"), at("F"));
  if (state === "RF-third-link") await link(at("R"), path.join(root, ".llmwiki", "indexed-retire.extra"));
  if (state === "RF-foreign-inode") await writeLeaf(root, BARRIER_NAMES.F, bytes, mode);
  if (state === "FW") await writeLeaf(root, BARRIER_NAMES.W, bytes, mode);
}

/** The stat lookup `barrierNameState` uses; tests inject one to observe how a failure is treated. */
export type BarrierLookup = (file: string) => Promise<{ ino: bigint; nlink: bigint; mode: bigint }>;

/** The real lookup: a non-following stat with bigint fields. */
const lstatBigint: BarrierLookup = (file) => lstat(file, { bigint: true });

/** Inode, link count, mode and bytes of each reserved name (null only when it is absent: ENOENT; every other lookup error propagates). */
export async function barrierNameState(root: string, lookup: BarrierLookup = lstatBigint): Promise<Record<string, string | null>> {
  const state: Record<string, string | null> = {};
  for (const [name, relPath] of Object.entries(BARRIER_NAMES)) {
    const file = path.join(root, relPath);
    const info = await lookup(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    state[name] = info === null ? null : `${info.ino}:${info.nlink}:${info.mode}:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  }
  return state;
}

/** Every reserved name absent. */
export const NO_BARRIER_NAMES = { F: null, R: null, W: null };

/** The active `local-indexed` record a retiring project carries (the maintenance scale leg refuses indexed stores without one). */
const ACTIVE_INDEXED: ScaleRecordV2 = { version: 2, policy: SCALE_POLICY_V2, revision: 1, requested: { documents: 100, sizeBytes: 102400, documentsBasis: "stated", sizeBasis: "stated" }, active: { architecture: "local-indexed", sinceRevision: 1 }, pending: null };

/** An active indexed project in a new private directory, with no run stores (a retirement plan with no candidate). */
export async function activeIndexedProject(privateDir: () => Promise<string>): Promise<string> {
  const root = await privateDir();
  await mkdir(path.join(root, ".llmwiki", "indexed"), { recursive: true });
  await writeFile(path.join(root, SCALE_RECORD_FILE), serializeAnyScaleRecord(ACTIVE_INDEXED));
  return root;
}
