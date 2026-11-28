/**
 * @file test/scale-measure/environment.ts
 * @description What every measurement driver records beside its results:
 * the ACTUAL bytes on disk (per indexed store, per incumbent file and per
 * corpus area, read after a step finished) and the measurement environment
 * (hardware, Node, git HEAD and a digest of the uncommitted tree, untracked
 * source and test files included). Shared by `./run.ts` and
 * `./batch-run.ts`; it has no entry point of its own.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Return an absent-path value only for ENOENT; keep measurement failures visible. */
async function ifAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try { return await read(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    throw error;
  }
}

/** Total bytes of every regular file under `dir` (0 when absent). */
async function bytesUnder(dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await ifAbsent(() => readdir(dir, { recursive: true }), [] as string[]);
  let files = 0;
  let bytes = 0;
  for (const name of entries) {
    const info = await lstat(path.join(dir, name));
    if (info.isFile()) { files += 1; bytes += info.size; }
  }
  return { files, bytes };
}

/** Actual on-disk bytes per indexed store, per incumbent file and per corpus area. */
export async function diskBytes(root: string): Promise<Record<string, unknown>> {
  const disk: Record<string, unknown> = {};
  for (const store of await ifAbsent(() => readdir(path.join(root, ".llmwiki", "indexed")), [] as string[])) {
    disk[`indexed/${store}`] = await bytesUnder(path.join(root, ".llmwiki", "indexed", store));
  }
  for (const leaf of ["wiki/graph/events.jsonl", "wiki/graph/relations.jsonl", ".llmwiki/embeddings.json", ".llmwiki/embeddings.bin", ".llmwiki/state.json", "wiki/index.md"]) {
    disk[leaf] = (await ifAbsent(() => lstat(path.join(root, leaf)), null))?.size ?? 0;
  }
  for (const area of ["sources", "wiki/concepts", ".llmwiki/workspaces"]) disk[area] = await bytesUnder(path.join(root, area));
  return disk;
}

/** The measurement environment: hardware, Node, and the exact source tree. */
export function environment(): Record<string, unknown> {
  const sh = (command: string, args: string[]) => { try { return execFileSync(command, args, { encoding: "utf8" }).trim(); } catch { return null; } };
  const git = (args: string[]): string => {
    try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch (cause) { throw new Error(`Git provenance unavailable: git ${args[0]} failed`, { cause }); }
  };
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "src", "test"]).split("\n").filter(Boolean).sort();
  const tree = createHash("sha256").update(git(["diff", "HEAD", "--binary"]));
  for (const file of untracked) tree.update(`\u0000${file}\u0000`).update(git(["hash-object", file]));
  return {
    node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    hwModel: sh("sysctl", ["-n", "hw.model"]), memBytes: os.totalmem(), head,
    uncommittedTreeSha256: tree.digest("hex"), untrackedFiles: untracked.length, at: new Date().toISOString(),
  };
}


/** A recorder appending each entry (stamped) to `results.entries` and rewriting `out`, so a partial run keeps what it measured. */
export function resultsRecorder(out: string, results: Record<string, unknown>): (entry: Record<string, unknown>) => Promise<void> {
  return async (entry) => {
    (results.entries as unknown[]).push({ ...entry, recordedAt: new Date().toISOString() });
    await writeFile(out, `${JSON.stringify(results, null, 1)}\n`);
  };
}
