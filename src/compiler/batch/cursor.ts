/**
 * @file src/compiler/batch/cursor.ts
 * @description The PHASE-AWARE shape of a batch compile run's cursor: for
 * each phase, exactly the resume fields that phase writes and reads, each
 * with its type and range, and the combinations it requires. A run store
 * whose meta carries a cursor its phase never writes (an unknown or
 * cross-phase field, a key where a sequence position belongs, a resumed
 * position without its companions) is a malformed (unknown) run, never a
 * position a phase would silently resume from.
 */

import { hasExactKeys, isCount } from "../../history/contracts.js";
import { MAX_KEY_CHARS } from "../../segments/contracts.js";
import type { BatchPhase } from "./contracts.js";

/** One field check. */
type Check = (value: unknown) => boolean;

/** One accepted cursor shape: the fields it must carry, and those it may. */
interface CursorShape { readonly required: Readonly<Record<string, Check>>; readonly optional?: Readonly<Record<string, Check>> }

/** A sequence position: a count, or -1 for "before the first". */
const position: Check = (value) => value === -1 || isCount(value);
/** A boolean flag. */
const flag: Check = (value) => typeof value === "boolean";
/** A flag that is set. */
const set: Check = (value) => value === true;
/** A listing row key (`f:<file>`) the hashing resumes after. */
const listingKey: Check = (value) => typeof value === "string" && value.startsWith("f:") && value.length <= MAX_KEY_CHARS;
/** A spilled walk's position (`./bfs.ts`). */
const walk: Check = (value) => hasExactKeys(value, ["head", "tail", "affected", "seeded"])
  && isCount(value.head) && isCount(value.tail) && isCount(value.affected) && typeof value.seeded === "boolean" && value.head <= value.tail;
/** A residual step after the first (the first is the empty cursor). */
const residualStep: Check = (value) => value === "index" || value === "moc" || value === "log";

/** The empty cursor. */
const EMPTY: CursorShape = { required: {} };
/** A two-phase planned rewrite (`./planned-writes.ts`): planned, then applied after a position. */
const APPLYING: CursorShape = { required: { planComplete: set, applied: position } };

/** The resolver's planning position (its index built, its plan resumable after a title row). */
const RESOLVE_PLANNING: Readonly<Record<string, Check>> = { indexed: set, hasNew: flag, after: position, planned: isCount };
/** Set once the resolver's new-title projection is built; absent in a run indexed before the projection existed. */
const RESOLVE_PROJECTED: Readonly<Record<string, Check>> = { newTitles: set };

/** Every phase's accepted cursor shapes. */
const SHAPES: Readonly<Record<BatchPhase, readonly CursorShape[]>> = {
  listing: [EMPTY, { required: { walked: set }, optional: { hashedAfter: listingKey } }],
  detect: [EMPTY],
  closure: [EMPTY, { required: { walk } }],
  "orphan-deleted": [{ required: { reconciled: isCount, after: position } }],
  extract: [{ required: { after: position, round: isCount }, optional: { late: walk } }],
  freeze: [EMPTY, { required: { after: position, frozen: isCount } }],
  "plan-generation": [EMPTY],
  generate: [{ required: { after: position } }],
  "plan-state": [{ required: { after: position } }],
  "orphan-frozen": [EMPTY],
  seeds: [EMPTY],
  resolve: [EMPTY, { required: RESOLVE_PLANNING, optional: RESOLVE_PROJECTED }, { required: { ...RESOLVE_PLANNING, ...APPLYING.required }, optional: RESOLVE_PROJECTED }],
  repair: [EMPTY, APPLYING],
  "finalize-state": [EMPTY],
  residual: [EMPTY, { required: { step: residualStep } }],
  done: [EMPTY],
  superseded: [EMPTY],
};

/** Whether `cursor` has exactly the fields of `shape`, each well-typed. */
function fits(cursor: Readonly<Record<string, unknown>>, shape: CursorShape): boolean {
  const required = Object.entries(shape.required).every(([field, check]) => Object.hasOwn(cursor, field) && check(cursor[field]));
  const known = { ...shape.optional, ...shape.required };
  return required && Object.entries(cursor).every(([field, value]) => Object.hasOwn(known, field) && known[field]!(value));
}

/** Whether `value` is a cursor the run's `phase` writes (see the file comment). */
export function isPhaseCursor(phase: BatchPhase, value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return SHAPES[phase].some((shape) => fits(value as Record<string, unknown>, shape));
}
