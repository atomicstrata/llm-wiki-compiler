/**
 * @file src/local-workflow-host/projection.ts
 * @description Core-owned derived projection persistence. The active profile owns
 * the target; callers supply rendered text, never a writable filesystem path.
 */
import path from "node:path";
import { lstat, open } from "node:fs/promises";
import { loadProfile } from "../profile/load.js";
import { lookupWorkflowDef } from "../workflow-history/definition.js";
import { atomicWrite } from "../utils/markdown.js";
import { confineUnderRoot, safeRealpath, isInsideDir } from "../utils/path-confine.js";

/** The single `wiki/` output root a projection target must resolve inside. */
const WIKI_ROOT = "wiki";

/** The stable marker prefix that identifies a file as a workflow-run projection. */
const DERIVED_MARKER = "<!-- DERIVED from the workflow run JSON";

/**
 * Bytes read (no-follow) from an existing target to recognize a prior projection.
 * A real projection carries the {@link DERIVED_MARKER} just after its (small)
 * frontmatter, well within this window; an authored page never does.
 */
const MARKER_PROBE_BYTES = 2048;

/** The outcome of {@link writeProjection}: written, no declared target, or fail-visible. */
export type ProjectionResult =
  | { status: "written"; path: string }
  | { status: "no-target" }
  | { status: "unavailable"; detail: string };

/**
 * Re-confine a profile-supplied `projectionFile` under `<root>/wiki/`, returning
 * the absolute write path. Fails CLOSED (throws) when the resolved path escapes
 * the `wiki/` output root — defense in depth, never trusting the path into
 * {@link atomicWrite} even though profile-load already validated it.
 *
 * @param root - Absolute project root.
 * @param projectionFile - The declared project-relative `wiki/...` target.
 * @returns The confined absolute write path under `<root>/wiki/`.
 * @throws When the resolved path escapes `<root>/wiki/`.
 */
export async function confineProjectionPath(root: string, projectionFile: string): Promise<string> {
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const wikiRoot = path.join(realRoot, WIKI_ROOT);
  const writePath = await confineUnderRoot(projectionFile, realRoot, { mustExist: false });
  if (!isInsideDir(writePath, wikiRoot)) {
    throw new Error(`projection path escapes wiki/: ${projectionFile}`);
  }
  return writePath;
}

/**
 * Whether the file at `writePath` is OK to overwrite with a projection. Reuses
 * NO-FOLLOW reads (`lstat` + an O-handle, never following a symlink): a regular
 * file is overwritable ONLY when it already begins with the {@link DERIVED_MARKER}
 * (i.e. it IS a prior projection — the normal re-project). A NON-projection file,
 * a symlink, or a directory is NOT overwritable. A missing target is overwritable
 * (nothing to clobber). Fail-closed: any read error treats the target as
 * non-overwritable. Defense in depth behind the reserved-subtree load gate.
 */
async function projectionTargetWritable(writePath: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(writePath); // no-follow: a symlink is never a projection
  } catch {
    return true; // missing target — nothing to clobber
  }
  if (!st.isFile()) return false; // symlink / directory / other → refuse
  const handle = await open(writePath, "r");
  try {
    const buf = Buffer.alloc(MARKER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MARKER_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8").includes(DERIVED_MARKER);
  } finally {
    await handle.close();
  }
}

/** Write rendered workflow text only to the active profile declared projection target. */
export async function writeLocalWorkflowProjection(root: string, workflowId: string, body: string): Promise<ProjectionResult> {
  const loaded = await loadProfile(root);
  const def = lookupWorkflowDef(loaded.profile.workflows, workflowId);
  if (def?.projectionFile === undefined) return { status: "no-target" };
  // Rendered frontmatter includes inputs and can exceed the existing overwrite
  // probe window. Do not impose a new size limit on valid first-time projections.
  if (!body.includes(DERIVED_MARKER)) {
    return { status: "unavailable", detail: "projection body is not a derived projection page" };
  }
  let writePath: string;
  try {
    writePath = await confineProjectionPath(root, def.projectionFile);
  } catch {
    return { status: "unavailable", detail: "projection path escapes wiki/" };
  }
  if (!(await projectionTargetWritable(writePath))) {
    return { status: "unavailable", detail: "projection target is not a projection page" };
  }
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  await atomicWrite(writePath, body, { confineRoot: realRoot });
  return { status: "written", path: def.projectionFile };
}
