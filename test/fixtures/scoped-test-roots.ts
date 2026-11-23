/**
 * @file Shared scaffolding for the durable recovery and scale-admission suites: private temporary
 * roots, the deterministic own-PID `serializeOwner` seam, and copies of a prepared project template.
 *
 * These helpers replace identical blocks that several suites carried inline. They change no test
 * semantics: each suite still chooses its own `mkdtemp` prefix, still registers its hooks at the same
 * position in its own scope (a hook-registering helper registers exactly where it is called), and keeps
 * its own cleanup timing (`afterAll` or `afterEach`). The seam spies the same `lock-owner` module object
 * the suites assert on (`expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid)`).
 */
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as lockOwner from "../../src/utils/lock-owner.js";

/** Anything a suite restores after a case. */
export interface Restorable { mockRestore(): void }

/** A suite's private temporary roots: create one (realpath'd, tracked) and remove every tracked root. */
export interface PrivateRoots {
  privateDir(): Promise<string>;
  cleanup(): Promise<void>;
}

/** Private roots under the OS temp directory named `<prefix>XXXXXX`; `cleanup` removes all created so far. */
export function privateRoots(prefix: string): PrivateRoots {
  const roots: string[] = [];
  return {
    async privateDir() {
      const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
      roots.push(dir);
      return dir;
    },
    async cleanup() {
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

/** The own-PID `serializeOwner` seam: a deterministic `{pid}` owner record (callers restore it). */
export function ownPidSerializeOwnerSpy(): Restorable {
  return spyOn(lockOwner, "serializeOwner").mockImplementation((pid) => JSON.stringify({ pid }));
}

/** Run `body` with the own-PID `serializeOwner` seam, restored afterwards (even when `body` throws). */
export async function withOwnPidOwnerSeam<T>(body: () => Promise<T>): Promise<T> {
  const seam = ownPidSerializeOwnerSpy();
  try { return await body(); } finally { seam.mockRestore(); }
}

/** Restore and forget every spy in `spies`, in insertion order. */
export function restoreAll(spies: Restorable[]): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
}

/**
 * Register, at the caller's scope, `beforeEach` installing the own-PID seam into `spies` and `afterEach`
 * restoring everything in `spies` (including any other spy the suite adds). Returns `spies`.
 */
export function ownPidOwnerSeamPerTest(spies: Restorable[] = []): Restorable[] {
  beforeEach(() => { spies.push(ownPidSerializeOwnerSpy()); });
  afterEach(() => { restoreAll(spies); });
  return spies;
}

/** A copy of `template` at `<new private dir>/wiki` with no reader-lease directory (never registered by this process). */
export async function copyProjectTemplate(template: string, privateDir: () => Promise<string>): Promise<string> {
  const root = path.join(await privateDir(), "wiki");
  await cp(template, root, { recursive: true });
  await rm(path.join(root, ".llmwiki", "indexed-readers"), { recursive: true, force: true });
  return root;
}
