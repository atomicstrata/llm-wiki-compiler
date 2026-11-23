/**
 * @file src/commands/quickstart-handoff.ts
 * @description The viewer-handoff decision of `llmwiki quickstart`, moved out
 * of `./quickstart.ts` unchanged so that file stays within the size rule:
 * whether the viewer starts after a successful run, and whether the printed
 * next action would only repeat the handoff that is about to happen.
 */

import type { RecommendedAction } from "../project/recommendations.js";
import type { ProjectState } from "../project/state.js";

/** The executable arg shape of the `llmwiki view --open` action. */
const VIEW_OPEN_ARGS_KEY = "view\u0000--open";

/** Next-action sub-envelope. Reuses Slice 1's recommendation shape. */
export interface NextEnvelope {
  command: string | null;
  reason: string;
  executable: RecommendedAction["executable"];
}

/** Inputs for the viewer-handoff gate; grouped so the predicate stays one screen. */
export interface HandoffGate {
  options: { open?: boolean; review?: boolean };
  jsonMode: boolean;
  compile: { ok: boolean };
  projectState: ProjectState | null;
}

type HandoffBlocker = (gate: HandoffGate) => boolean;

const VIEWER_HANDOFF_BLOCKERS: HandoffBlocker[] = [
  (gate) => gate.jsonMode,
  (gate) => gate.options.open === false,
  (gate) => gate.options.review === true,
  (gate) => !gate.compile.ok,
  (gate) => !hasRenderablePages(gate.projectState),
];

/**
 * Viewer Lifecycle start condition (plan §Viewer Lifecycle): wiki pages
 * exist, `--no-open` is false, `--json` is false, and `--review` is
 * false. Compile must also have completed cleanly — opening the viewer
 * on a compile-failure path would surface stale or partial wiki state
 * to the user.
 */
export function shouldStartViewer(gate: HandoffGate): boolean {
  return VIEWER_HANDOFF_BLOCKERS.every((isBlocked) => !isBlocked(gate));
}

/** A viewer handoff is useful only when there is at least one rendered page. */
function hasRenderablePages(state: ProjectState | null): boolean {
  return conceptCountOf(state) + queryCountOf(state) > 0;
}

/** Null-safe concept count for the viewer handoff predicate. */
function conceptCountOf(state: ProjectState | null): number {
  return state === null ? 0 : state.conceptCount;
}

/** Null-safe saved-query count for the viewer handoff predicate. */
function queryCountOf(state: ProjectState | null): number {
  return state === null ? 0 : state.queryCount;
}

/**
 * Drop the `Next:` line ONLY when the recommendation is the redundant
 * `llmwiki view --open` action and the viewer is about to start —
 * printing it right above the handoff line would just echo the action
 * that's about to take over the foreground. Other recommendations
 * (e.g. `llmwiki lint` when a populated lint cache has errors,
 * `llmwiki review list` when candidates are pending) must survive
 * handoff so the user still sees the follow-up to run after Ctrl+C.
 * The JSON envelope is unaffected because handoff only happens in
 * human mode and `--json` always implies `--no-open`.
 */
export function suppressRedundantViewerNext(next: NextEnvelope, handoff: boolean): NextEnvelope {
  if (!handoff) return next;
  if (!isViewOpenAction(next)) return next;
  return { command: null, reason: next.reason, executable: null };
}

/**
 * True when `next` is the literal `llmwiki view --open` action. Matches
 * on the executable arg shape rather than the display string so a
 * future cosmetic tweak to `command` doesn't silently break the
 * suppression invariant.
 */
function isViewOpenAction(next: NextEnvelope): boolean {
  return next.executable?.args.join("\u0000") === VIEW_OPEN_ARGS_KEY;
}
