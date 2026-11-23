/**
 * @file A deterministic directory-sync fault for the durable recovery suites.
 *
 * LABELLED SEAM: `failDirectorySyncWhen` spies `atomic-write-durability.fsyncDirectoryChain` and throws
 * `message` at the FIRST sync observed after every `gone` name is absent and every `kept` name present;
 * every other sync calls through to the real function. It replaces two identical inline copies whose
 * only difference was the injected message, which each suite still passes explicitly.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { spyOn } from "bun:test";
import * as durability from "../../src/utils/atomic-write-durability.js";

/** Whether `relPath` under `root` is present (any lstat-able entry). */
export const presentAt = (root: string, relPath: string): Promise<boolean> => lstat(path.join(root, relPath)).then(() => true, () => false);

/** Fail the first directory sync once every `gone` name is absent and every `kept` one present (with `message`); otherwise call through. */
export function failDirectorySyncWhen(root: string, gone: readonly string[], kept: readonly string[], message: string): { mockRestore(): void } {
  const real = durability.fsyncDirectoryChain;
  let thrown = false;
  const armed = async () => (await Promise.all(gone.map((name) => presentAt(root, name)))).every((at) => !at) && (await Promise.all(kept.map((name) => presentAt(root, name)))).every(Boolean);
  return spyOn(durability, "fsyncDirectoryChain").mockImplementation(async (...args: Parameters<typeof real>) => {
    if (!thrown && (await armed())) { thrown = true; throw new Error(message); }
    return real(...args);
  });
}
