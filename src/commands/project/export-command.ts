/**
 * @file src/commands/project/export-command.ts
 * @description `llmwiki project export --out <dir>`: write a portable export
 * to disk without ever putting user data at risk or presenting a partial
 * export as a complete one.
 *
 *  - The destination must not exist. An existing directory is never replaced.
 *  - Objects are staged in a FRESH directory this run creates itself. Nothing
 *    that already existed is deleted, not even a previous run's leftovers.
 *  - Every item is validated before it is written: its logical path must stay
 *    inside the staging directory, must not collide with the manifest, must not
 *    repeat, and its bytes must hash to the digest the host stated.
 *  - The staging directory is moved into place only when the stream ends in
 *    `completed` with the count that was actually received. Otherwise it is
 *    left where it is and reported, so nothing unverified is promoted.
 */

import { lstat, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { bytesDigest } from "../../portable/digest.js";
import type { ExportItem, WikiProject } from "../../portable/project/api.js";

/** The file this command writes beside the exported objects. */
const MANIFEST_NAME = "export-manifest.json";

/** Treat every occupied output name, including a dangling symlink, as existing. */
async function targetExists(out: string): Promise<boolean> {
  try { await lstat(out); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One exported object as recorded in the manifest. */
interface ExportedObject { path: string; digest: string; labels: readonly string[] }

/** Why an export was not promoted. */
type NotPromoted = { kind: "stopped"; reason: string; partial: string };

/** The file inside `staging` an exported logical path is written to, or `null` when unacceptable. */
function stagedFileFor(staging: string, logicalPath: string): string | null {
  const segments = logicalPath.split("/");
  const safe = segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\\0]/u.test(segment));
  const file = path.join(staging, ...segments);
  const inside = path.relative(staging, file);
  if (!safe || inside.startsWith("..") || path.isAbsolute(inside) || inside === MANIFEST_NAME) return null;
  return file;
}

/** Validate and stage one object. Returns the reason it was rejected, or `null`. */
async function stageObject(
  staging: string, item: Extract<ExportItem, { kind: "object" }>, seen: Set<string>,
): Promise<string | null> {
  const file = stagedFileFor(staging, item.path);
  if (file === null) return "unsafe_path";
  if (seen.has(item.path)) return "duplicate_path";
  if (bytesDigest(item.bytes) !== item.digest) return "digest_mismatch";
  seen.add(item.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, item.bytes, { flag: "wx" });
  return null;
}

/** Stage the whole stream. Returns the objects received, or why the stream cannot be promoted. */
async function stageStream(project: WikiProject, staging: string): Promise<ExportedObject[] | NotPromoted> {
  const objects: ExportedObject[] = [];
  const seen = new Set<string>();
  for await (const item of project.export()) {
    if (item.kind === "stopped") return { kind: "stopped", reason: item.reason, partial: staging };
    if (item.kind === "completed") {
      const counted = item.count === objects.length;
      return counted ? objects : { kind: "stopped", reason: "count_mismatch", partial: staging };
    }
    const rejected = await stageObject(staging, item, seen);
    if (rejected !== null) return { kind: "stopped", reason: rejected, partial: staging };
    objects.push({ path: item.path, digest: item.digest, labels: item.labels });
  }
  // A stream that simply ends without saying `completed` is not a complete export.
  return { kind: "stopped", reason: "incomplete_stream", partial: staging };
}

/**
 * Export `project` into `out`. Promotes only a completed, fully validated stream.
 *
 * @throws Error when `out` already exists: an existing target is never replaced.
 */
export async function exportToDirectory(project: WikiProject, out: string): Promise<unknown> {
  if (await targetExists(out)) {
    throw new Error(`export target already exists and will not be replaced: ${out}`);
  }
  await mkdir(path.dirname(out), { recursive: true });
  // Created by this run and owned by it: nothing pre-existing is ever touched.
  const staging = await mkdtemp(path.join(path.dirname(out), `${path.basename(out)}.partial-`));
  const staged = await stageStream(project, staging);
  if (!Array.isArray(staged)) return staged;
  await writeFile(path.join(staging, MANIFEST_NAME), JSON.stringify({ objects: staged }, null, 2), { flag: "wx" });
  await rename(staging, out);
  return { kind: "committed", out, objects: staged };
}
