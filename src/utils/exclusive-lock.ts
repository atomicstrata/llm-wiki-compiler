/**
 * @file src/utils/exclusive-lock.ts
 * @description Token-owned bounded file lock for authoritative mutable state.
 * Shared by the tap operator state and the publisher workspace: a second copy of
 * this acquire/stale-reclaim/release dance is how two lock implementations drift.
 */
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { readConfinedLeaf } from "./confined-read.js";
import { isOwnerStale, parseOwner, serializeOwner } from "./lock-owner.js";
import { ensurePrivateRoot } from "../profile/templates/taps/private-root.js";

const MAX_LOCK_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 25;

interface OperatorLockRecord { pid: number; startTime?: string; token: string }

/** The two paths a file lock needs: its confined private root and the lock leaf. */
export interface LockPaths {
  root: string;
  lockFile: string;
}

/** Run one authoritative read-modify-write while holding the exclusive lock. */
export async function withExclusiveLock<T>(paths: LockPaths, operation: () => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const token = await acquireOperatorLock(paths, timeoutMs);
  try {
    return await operation();
  } finally {
    await releaseOperatorLock(paths, token);
  }
}

async function acquireOperatorLock(paths: LockPaths, timeoutMs: number): Promise<string> {
  await ensurePrivateRoot(paths.root);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomBytes(24).toString("hex");
    if (await tryCreate(paths.lockFile, token)) return token;
    await reclaimIfStale(paths);
    if (Date.now() >= deadline) throw new Error("template tap state is busy");
    await delay(POLL_MS);
  }
}

async function tryCreate(lockFile: string, token: string): Promise<boolean> {
  const owner = JSON.parse(serializeOwner(process.pid)) as { pid: number; startTime?: string };
  const record: OperatorLockRecord = { ...owner, token };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    await handle?.close().catch(() => {});
    if (handle !== undefined) await unlink(lockFile).catch(() => {});
    throw error;
  }
}

async function reclaimIfStale(paths: LockPaths): Promise<void> {
  const record = await readRecord(paths, paths.lockFile);
  if (!record || !isOwnerStale(record)) return;
  const reclaim = `${paths.lockFile}.reclaim`;
  const token = randomBytes(24).toString("hex");
  if (!(await acquireReclaim(paths, reclaim, token))) return;
  try {
    const current = await readRecord(paths, paths.lockFile);
    if (current && isOwnerStale(current)) await unlink(paths.lockFile).catch(() => {});
  } finally {
    await unlink(reclaim).catch(() => {});
  }
}

async function acquireReclaim(paths: LockPaths, file: string, token: string): Promise<boolean> {
  if (await tryCreate(file, token)) return true;
  const existing = await readRecord(paths, file);
  if (existing && isOwnerStale(existing)) await unlink(file).catch(() => {});
  return false;
}

async function readRecord(paths: LockPaths, file: string): Promise<OperatorLockRecord | null> {
  const read = await readConfinedLeaf(paths.root, file, paths.root, MAX_LOCK_BYTES);
  if (read.kind !== "ok") return null;
  try {
    const value = JSON.parse(read.body) as Record<string, unknown>;
    const owner = parseOwner(JSON.stringify(value));
    if (!owner || typeof value.token !== "string" || !/^[0-9a-f]{48}$/.test(value.token)) return null;
    return { ...owner, token: value.token };
  } catch {
    return null;
  }
}

async function releaseOperatorLock(paths: LockPaths, token: string): Promise<void> {
  const record = await readRecord(paths, paths.lockFile);
  if (record?.token !== token || record.pid !== process.pid) return;
  await unlink(paths.lockFile).catch(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
