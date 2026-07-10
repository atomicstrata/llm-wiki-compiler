/**
 * @file src/workflows/projection.ts
 * @description A DERIVED, one-way markdown projection of a workflow run.
 *
 * A workflow run is core-owned JSON (the SOURCE OF TRUTH, persisted under the
 * private `.llmwiki/` dir; see `./store.js`). When a workflow def declares a
 * `projectionFile` (a `wiki/...` path confined under `wiki/` at profile-load),
 * `workflow project` renders a human-readable markdown view of the run to that
 * path. The projection is DERIVED: it is computed FROM the run JSON and is a
 * `wiki/` OUTPUT, not run state. Editing the markdown can NEVER affect the run —
 * nothing in this module (or in validation/read) ever consumes the markdown back
 * into a record; every status/read path reads the run JSON, never the projection.
 *
 * ## Confinement (no page-clobber)
 * The profile validator confines `projectionFile` to the RESERVED projection
 * subtree (`wiki/outputs/workflows/`) at LOAD, so a `projectionFile` can never
 * name an authored entity page. On top of that, the resolved write path is
 * RE-CONFINED here ({@link confineProjectionPath}) before it reaches
 * {@link atomicWrite}: a path that escapes `<root>/wiki/` fails CLOSED. As a final
 * defense in depth, {@link writeProjection} refuses to overwrite a target that
 * EXISTS but is NOT already a projection (no `<!-- DERIVED from the workflow run
 * JSON` marker, read NO-FOLLOW) — so even within the reserved subtree an authored
 * file is never clobbered (a prior projection IS overwritable: the normal
 * re-project). The write goes through `atomicWrite({ confineRoot })`, the same
 * leaf-symlink-hardened primitive every `wiki/` writer uses.
 */

import path from "node:path";
import { lstat, open } from "node:fs/promises";
import { loadProfile } from "../profile/load.js";
import { lookupWorkflowDef } from "./start.js";
import { readRun } from "./store.js";
import { atomicWrite, buildFrontmatter } from "../utils/markdown.js";
import { confineUnderRoot, safeRealpath, isInsideDir } from "../utils/path-confine.js";
import type { WorkflowRun } from "./types.js";

/** The single `wiki/` output root a projection target must resolve inside. */
const WIKI_ROOT = "wiki";

/** The header marking the projection as derived + one-way (edits do not affect run state). */
const DERIVED_HEADER = "<!-- DERIVED from the workflow run JSON; edits here do NOT affect run state. -->";

/** The stable marker prefix that identifies a file as a workflow-run projection. */
const DERIVED_MARKER = "<!-- DERIVED from the workflow run JSON";

/**
 * Bytes read (no-follow) from an existing target to recognize a prior projection.
 * A real projection carries the {@link DERIVED_MARKER} just after its (small)
 * frontmatter, well within this window; an authored page never does.
 */
const MARKER_PROBE_BYTES = 2048;

/**
 * Render the run's append-only stage log as one markdown bullet per entry, in
 * order (`- <stageId>: <status>`). Pure and deterministic.
 *
 * @param run - The run whose `stageLog` is rendered.
 * @returns The stage-log lines joined by newlines (empty string for no stages).
 */
function renderStageLog(run: WorkflowRun): string {
  return run.stageLog.map((entry) => `- ${entry.stageId}: ${entry.status}`).join("\n");
}

/**
 * Render a workflow run as a DERIVED markdown projection.
 *
 * PURE and deterministic. Frontmatter (built via the shared {@link buildFrontmatter}
 * so the YAML is vetted/consistent) carries the run's identity + position +
 * inputs/outputs; the body is the {@link DERIVED_HEADER} followed by a `## Stage
 * Log` section with one line per `stageLog` entry, in order.
 *
 * This is a ONE-WAY view: the markdown is DERIVED from the run JSON and is never
 * read back into run state — editing it cannot mutate the run.
 *
 * @param run - The core-owned run record (the source of truth).
 * @returns The markdown projection (frontmatter + derived header + stage log).
 */
export function projectRun(run: WorkflowRun): string {
  const frontmatter = buildFrontmatter({
    workflow: run.workflowId,
    runId: run.runId,
    status: run.status,
    currentStage: run.currentStage,
    // STAMP the run's monotonic state version so a reader/lint can detect a STALE
    // projection (this stamped version < the run's current stateVersion).
    stateVersion: run.stateVersion,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    inputs: run.inputs,
    outputs: run.outputs,
  });
  return `${frontmatter}\n\n${DERIVED_HEADER}\n\n## Stage Log\n\n${renderStageLog(run)}\n`;
}

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

/**
 * Write the DERIVED projection for an ALREADY-READ run to its workflow's declared
 * `projectionFile`. Factored out of {@link writeProjection} so the auto-project
 * hook ({@link maybeAutoProject}) can re-use the exact same confine→writability→
 * atomic-write path WITHOUT re-reading the run (the op already holds it). Loads the
 * profile + def; a removed def or absent `projectionFile` is `no-target`. The write
 * path is RE-CONFINED under `<root>/wiki/` (fail-closed) before the atomic write.
 *
 * @param root - Absolute project root.
 * @param run - The run record to project (the source of truth).
 * @returns The discriminated {@link ProjectionResult}.
 */
async function writeRunProjection(root: string, run: WorkflowRun): Promise<ProjectionResult> {
  const loaded = await loadProfile(root);
  const def = lookupWorkflowDef(loaded.profile.workflows, run.workflowId);
  if (def?.projectionFile === undefined) return { status: "no-target" };
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
  await atomicWrite(writePath, projectRun(run), { confineRoot: realRoot });
  return { status: "written", path: def.projectionFile };
}

/**
 * Write a run's DERIVED markdown projection to its workflow's declared
 * `projectionFile` under `wiki/`, returning a discriminated {@link ProjectionResult}.
 *
 * Reads the run JSON (`unavailable` — fail-visible — when absent/unreadable, so a
 * broken/unknown run is never silently skipped). Loads the active profile and the
 * run's workflow def; when the def is gone or declares no `projectionFile`, there
 * is nothing to write (`no-target`). The write path is RE-CONFINED under
 * `<root>/wiki/` (fail-closed on escape) before the atomic write. This is a
 * `wiki/` OUTPUT write only — it takes NO run lock and never mutates run state.
 *
 * @param root - Absolute project root.
 * @param runId - The run id whose projection to write.
 * @returns `written` with the project-relative path; `no-target` when nothing is
 *   declared; `unavailable` (with detail) when the run/store/path is fail-visible.
 */
export async function writeProjection(root: string, runId: string): Promise<ProjectionResult> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") {
    return { status: "unavailable", detail: read.status === "absent" ? "run-absent" : read.detail };
  }
  return writeRunProjection(root, read.run);
}

/**
 * BEST-EFFORT auto-project hook: regenerate the projection for a just-mutated run
 * so a declared `projectionFile` stays FRESH after every state-mutating op
 * (advance/gate/cancel/fail/resume/submit/adapt) instead of silently going stale.
 *
 * Called by the ops AFTER the run write succeeds (never under the lock-failure
 * path): a projection-write failure must NOT fail the op, so EVERY error here is
 * SWALLOWED (logged once to stderr) — the run is already durably committed, and a
 * stale projection is a degraded read-surface, not a lost mutation. A workflow with
 * no `projectionFile` is a `no-target` no-op, so parity is preserved (a default
 * project declares none, so nothing is ever written and behavior is unchanged).
 *
 * @param root - Absolute project root.
 * @param run - The freshly persisted run record to re-project.
 */
export async function maybeAutoProject(root: string, run: WorkflowRun): Promise<void> {
  try {
    await writeRunProjection(root, run);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[33mwarning:\x1b[0m auto-projection failed for run ${run.runId}: ${detail}`);
  }
}
