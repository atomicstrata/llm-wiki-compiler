/**
 * @file src/viewer/navigation-write.ts
 * @description Writing the derived navigation artifacts under the wiki tree
 * (AS-1 §4.9), with the one rule that makes regeneration safe to re-run.
 *
 * USER CUSTOMIZATIONS ARE CREATED BUT NEVER OVERWRITTEN — §4.9's pinned
 * outcome, and the reason this opens with an EXCLUSIVE create rather than
 * checking for existence and then writing. An
 * Obsidian graph configuration is a file a person edits: they set their own
 * colours, add their own filters. A `visualize` that rewrote it would silently
 * discard that work on every run, and "regenerate my navigation" would become a
 * command nobody dares run twice. So an existing file is LEFT ALONE and
 * reported as skipped; the caller decides whether that matters.
 *
 * The Canvas map follows the same rule for the same reason: a canvas is a
 * layout someone rearranges by hand.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** What happened to one artifact: written fresh, or left as the user had it. */
export type ArtifactWriteV1 = "created" | "skipped-existing";

/** One artifact's path and disposition. */
export interface ArtifactWriteResultV1 {
  readonly file: string;
  readonly outcome: ArtifactWriteV1;
}

/**
 * Write one derived artifact, refusing to clobber an existing file.
 *
 * @param root - Project root the artifact is written under.
 * @param relativePath - Wiki-tree-relative destination.
 * @param body - The serialized artifact.
 * @returns Whether it was created or an existing file was preserved.
 */
export async function writeDerivedArtifact(
  root: string, relativePath: string, body: string,
): Promise<ArtifactWriteResultV1> {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    // EXCLUSIVE create, not stat-then-write. Checking for existence and then
    // writing leaves a window in which a file appears between the two and is
    // silently overwritten — which is exactly the customization this promises
    // never to clobber. `wx` makes the check and the write one operation.
    await writeFile(destination, body, { encoding: "utf8", flag: "wx" });
    return { file: relativePath, outcome: "created" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { file: relativePath, outcome: "skipped-existing" };
    }
    throw error;
  }
}
