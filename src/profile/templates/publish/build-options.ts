/**
 * @file src/profile/templates/publish/build-options.ts
 * @description Build input validation: where output may go, and how long it lives.
 */
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { readCappedNoFollow } from "../../../utils/confined-read.js";
import { canonicalDigest } from "../signing/canonical.js";
import { parseSignedTapIndex } from "../signing/protocol.js";
import type { LastBuild } from "./workspace-types.js";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
import path from "node:path";
import type { WorkspacePaths } from "./workspace-paths.js";

const MIN_EXPIRY_MS = 60 * 60 * 1000;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Refuse an output directory inside the workspace, or a workspace inside the output.
 * The workspace holds PRIVATE KEYS and the output is built for public HTTPS hosting, so
 * this is the key-exfiltration control. Both sides are resolved with `realpath` — a
 * lexical comparison is defeated by a symlinked path.
 */
export async function assertOutsideWorkspace(
  paths: WorkspacePaths,
  out: string,
  lastBuild: LastBuild | undefined,
): Promise<string> {
  const resolvedOut = path.resolve(out);
  await mkdir(path.dirname(resolvedOut), { recursive: true });
  const realWorkspace = await realpath(paths.root);
  const realOut = await realExistingAncestor(resolvedOut);

  if (contains(realWorkspace, realOut) || contains(realOut, realWorkspace)) {
    throw new Error("build output must live outside the publisher workspace: it would publish private keys");
  }
  await assertReplaceableOutput(resolvedOut, lastBuild);
  return resolvedOut;
}

/**
 * Publishing REPLACES the whole output directory: it is renamed aside and then deleted. So
 * the only things safe to point `--out` at are nothing, an empty directory, or A TREE THIS
 * WORKSPACE ITSELF PUBLISHED.
 *
 * "Looks like a distribution of this tap" is NOT sufficient: an index is just bytes, and
 * anyone can write one that claims any tap name. The output is only replaceable when its
 * index digests to exactly what `lastBuild` recorded — an identity we produced and stored,
 * so no attacker-supplied bytes can satisfy it.
 */
async function assertReplaceableOutput(out: string, lastBuild: LastBuild | undefined): Promise<void> {
  const info = await lstat(out).catch(() => null);
  if (info === null) return;
  if (!info.isDirectory()) throw new Error("build output path exists and is not a directory");

  const entries = await readdir(out);
  if (entries.length === 0) return;
  if (!(await isOurPreviousBuild(out, entries, lastBuild))) {
    throw new Error(
      "build output directory is not empty and is not a tree this workspace published; "
      + "publishing would delete its contents",
    );
  }
}

/** Exactly index.json + packages/, whose index is byte-for-byte the one we last published. */
async function isOurPreviousBuild(
  out: string,
  entries: string[],
  lastBuild: LastBuild | undefined,
): Promise<boolean> {
  if (lastBuild === undefined) return false;
  if (entries.sort().join(",") !== "index.json,packages") return false;
  const read = await readCappedNoFollow(path.join(out, "index.json"), MAX_INDEX_BYTES);
  if (read.kind !== "ok") return false;
  try {
    return canonicalDigest(parseSignedTapIndex(read.body)) === lastBuild.indexDigest;
  } catch {
    return false;
  }
}

/** Convert a bounded duration (`30d`, `12h`) into an absolute expiry. */
export function parseExpiresIn(value: string, now: Date): Date {
  const match = /^(\d{1,4})([hd])$/.exec(value);
  if (!match) throw new Error("--expires-in must look like 30d or 12h");
  const unitMs = match[2] === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const durationMs = Number(match[1]) * unitMs;
  if (durationMs < MIN_EXPIRY_MS) throw new Error("--expires-in must be at least 1h");
  if (durationMs > MAX_EXPIRY_MS) throw new Error("--expires-in must be at most 365d");
  return new Date(now.getTime() + durationMs);
}

/** Realpath the nearest existing ancestor, so a not-yet-created output still resolves. */
async function realExistingAncestor(target: string): Promise<string> {
  for (let current = target; ; current = path.dirname(current)) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return path.join(real, path.relative(current, target));
    if (path.dirname(current) === current) return target;
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}
