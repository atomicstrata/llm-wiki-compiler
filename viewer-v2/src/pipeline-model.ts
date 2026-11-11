/**
 * Facts the lifecycle screen derives from a profile's pipeline: which states
 * a type's transitions can reach, what role each tallied state plays, and the
 * sentences that explain a row. Pure functions, so the rules are tested as
 * arithmetic rather than as markup.
 *
 * Three roles. `terminal` is declared so by the profile. `unreachable` means
 * no path of declared transitions runs from `initial` to the state, or the
 * state is not a declared value at all; either way the lifecycle cannot
 * produce it. `flight` is everything else. A lifecycle that declares no
 * terminal state and no transition orders nothing, so every state stays
 * `flight`: "not declared" is a different finding from "declared and
 * unreachable", and inventing an order would be the worse error.
 */
import type { EntityTypeRow, PipelineLifecycle } from "./api";
import { plural } from "./wiki-model";

export type StateRole = "flight" | "terminal" | "unreachable" | "empty";

/** One lifecycle state with its page count and how the screen treats it. */
export interface StateTally {
  state: string;
  count: number;
  role: StateRole;
}

/** Whether the lifecycle declares anything that puts its states in an order. */
export function hasDeclaredOrder(lifecycle: PipelineLifecycle | undefined): boolean {
  if (!lifecycle) return false;
  const edges = Object.values(lifecycle.transitions ?? {}).reduce((total, targets) => total + targets.length, 0);
  return lifecycle.terminal.length > 0 || edges > 0;
}

/**
 * The states reachable from `initial`, breadth-first in transition order, so
 * a fork reads nearest-first. The enum never decides this: its order is an
 * accident of how the profile was written.
 */
export function reachableOrder(lifecycle: PipelineLifecycle | undefined): string[] {
  if (!lifecycle) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [lifecycle.initial];
  while (queue.length > 0) {
    const state = queue.shift() as string;
    if (seen.has(state)) continue;
    seen.add(state);
    order.push(state);
    queue.push(...(lifecycle.transitions?.[state] ?? []));
  }
  return order;
}

/** The role of one tallied state; every state of an orderless type is in flight. */
function roleOf(state: string, lifecycle: PipelineLifecycle | undefined, chain: string[], ordered: boolean): StateRole {
  if (!ordered || !lifecycle) return "flight";
  if (lifecycle.terminal.includes(state)) return "terminal";
  return chain.includes(state) ? "flight" : "unreachable";
}

/** Chain order first, then the states the chain never reaches, biggest pile first. */
function sortTallied(tallied: [string, number][], chain: string[]): [string, number][] {
  const rank = (state: string): number => {
    const index = chain.indexOf(state);
    return index === -1 ? chain.length : index;
  };
  return [...tallied].sort(([aState, aCount], [bState, bCount]) => rank(aState) - rank(bState) || bCount - aCount);
}

/** Classify and order every tallied state of one entity type; zero counts are left out. */
export function classifyStates(lifecycle: PipelineLifecycle | undefined, stateCounts: Record<string, number> | undefined): StateTally[] {
  const ordered = hasDeclaredOrder(lifecycle);
  // Walked once and used for both the role and the reading position, which must agree.
  const chain = ordered ? reachableOrder(lifecycle) : [];
  const withPages = Object.entries(stateCounts ?? {}).filter(([, count]) => count > 0);
  return sortTallied(withPages, chain).map(([state, count]) => ({ state, count, role: roleOf(state, lifecycle, chain, ordered) }));
}

/** The tallied states plus every declared or reachable state with no pages, at zero. */
export function displayedStates(lifecycle: PipelineLifecycle | undefined, states: StateTally[]): StateTally[] {
  const names = new Set([...reachableOrder(lifecycle), ...(lifecycle?.declaredStates ?? []), ...states.map((entry) => entry.state)]);
  const tallied = new Map(states.map((entry) => [entry.state, entry]));
  return [...names].map((state) => tallied.get(state) ?? { state, count: 0, role: "empty" });
}

/** A chip's text; unreachable and terminal name their role in words, not only in colour. */
export function chipLabel(state: StateTally): string {
  const base = `${state.count} ${state.state}`;
  return state.role === "unreachable" || state.role === "terminal" ? `${base} · ${state.role}` : base;
}

/** What the profile declared, stated rather than derived. */
export function declaredText(lifecycle: PipelineLifecycle | undefined): string {
  if (!lifecycle) return "No stages configured";
  if (!hasDeclaredOrder(lifecycle)) {
    return `${plural(lifecycle.declaredStates?.length ?? 0, "state")} declared · no transitions, no terminal — order not derivable, so none is implied`;
  }
  const initial = `initial ${lifecycle.initial}`;
  return lifecycle.terminal.length > 0 ? `${initial} · terminal ${lifecycle.terminal.join(", ")}` : initial;
}

/**
 * Why a state is unreachable, in the profile's words. A declared state no
 * transition reaches is a hole in the state machine; an undeclared one never
 * passed validation. Both mean someone edited the frontmatter by hand.
 */
export function calloutReason(state: string, lifecycle: PipelineLifecycle): string {
  const field = lifecycle.field || "the lifecycle field";
  if (lifecycle.declaredStates !== undefined && !lifecycle.declaredStates.includes(state)) {
    return `not a declared \`${field}\` value at all`;
  }
  return `declared on \`${field}\` but no transition reaches it from \`${lifecycle.initial}\``;
}

/** The sentence of an unreachable-state callout. */
export function calloutText(state: StateTally, lifecycle: PipelineLifecycle): string {
  const verb = state.count === 1 ? "sits" : "sit";
  return `${plural(state.count, "page")} ${verb} in ${state.state} — ${calloutReason(state.state, lifecycle)}, so the configured transitions cannot reach it. Check this record’s state and the project’s allowed transitions.`;
}

/** The tally sum and how many pages in it failed validation; both zero without a lifecycle. */
export interface RowVerdict {
  sum: number;
  rejected: number;
}

/**
 * The tally counts every page that declares a state, valid or not, while
 * `pageCount` counts valid pages only; the difference is exactly the rejected
 * pages that still declare a state.
 */
export function rowVerdict(row: EntityTypeRow): RowVerdict {
  const sum = Object.values(row.stateCounts ?? {}).reduce((total, count) => total + count, 0);
  return { sum, rejected: Math.max(0, sum - row.pageCount) };
}

/** The finding under a row's tally sum. */
export function gapText({ sum, rejected }: RowVerdict): string {
  if (sum === 0) return "No records with a recorded state";
  return rejected > 0 ? `${plural(rejected, "rejected page")} counted here` : "All counted records have recognized states";
}

/** Rejected pages across every type. */
export function totalRejected(entityTypes: EntityTypeRow[]): number {
  return entityTypes.reduce((total, row) => total + rowVerdict(row).rejected, 0);
}

/**
 * The footer's sentence. A rejected page that omits the lifecycle field
 * appears in no tally, so the count is a floor, and the sentence says so.
 */
export function footerText(rejected: number): string {
  if (rejected === 0) return "No rejected page declares a lifecycle state, so every tally above counts profile-valid pages only.";
  const clause = rejected === 1 ? "declares a lifecycle state and is" : "declare a lifecycle state and are";
  return `${plural(rejected, "rejected page")} still ${clause} counted in the tallies above. A rejected page that omits the field entirely appears in no tally at all.`;
}
