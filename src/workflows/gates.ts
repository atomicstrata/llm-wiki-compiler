/**
 * @file src/workflows/gates.ts
 * @description The ONE gate-string parser shared across the workflow surfaces.
 *
 * A stage gate is a `<kind>:<id>` string where `kind ∈ {human, agent, trust}`.
 * Three independent surfaces parse it: `gate.ts` (approve a human/agent gate),
 * `advance.ts` (refuse a trust gate it cannot execute), and `status.ts` (report
 * the awaiting-gate id). They previously each carried a local copy of the
 * colon-split; this module is the single definition so the grammar — what counts
 * as a well-formed gate, which kinds are known, and what the `trust:` marker is —
 * lives in exactly one place.
 *
 * {@link parseGate} fails CLOSED: a malformed string (no colon, an empty kind, an
 * empty id) OR an UNKNOWN kind returns `null`, never a partial parse. The narrowed
 * {@link GateKind} is what callers branch on, so an out-of-vocabulary kind cannot
 * be mistaken for a satisfiable gate. {@link isTrustGate} is the cheap prefix
 * check the write/advance paths use to recognize a trust gate without a full parse.
 */

/** The gate kinds a stage gate may declare, in vocabulary order. */
export const GATE_KINDS = ["human", "agent", "trust"] as const;

/** A recognized gate kind (a member of {@link GATE_KINDS}). */
export type GateKind = (typeof GATE_KINDS)[number];

/** A parsed `<kind>:<id>` gate with a recognized kind. */
export interface ParsedGate {
  /** The gate kind (`human`/`agent`/`trust`). */
  kind: GateKind;
  /** The gate id (the part after the first colon). */
  id: string;
}

/**
 * The single gate grammar: `<kind>:<id>` where `kind ∈ {human, agent, trust}` and
 * `id` is a non-empty slug-safe token (`[a-z0-9][a-z0-9-]*`). This MIRRORS the
 * profile validator's `GATE_PATTERN` so a persisted `satisfiedGates` entry is held
 * to the SAME contract the profile enforces on declared gates — a run can never
 * carry a satisfied gate the validator would have rejected.
 */
const GATE_PATTERN = /^(human|agent|trust):[a-z0-9][a-z0-9-]*$/;

/** The `<kind>:` prefix marking a `trust:` gate (the Trust Guard's write path). */
const TRUST_GATE_PREFIX = "trust:";

/**
 * True when `gate` is a well-formed `<kind>:<id>` string under {@link GATE_PATTERN}
 * (recognized kind + slug-safe id). The fail-closed predicate the run-record
 * validator uses to vet every persisted `satisfiedGates` entry, so a forged gate
 * string (a bare number, an object, a `human:Bad/Id`) rejects the whole record.
 *
 * @param gate - The candidate gate string.
 * @returns Whether the gate matches the shared gate grammar.
 */
export function isWellFormedGate(gate: string): boolean {
  return GATE_PATTERN.test(gate);
}

/** True when `kind` is one of the recognized {@link GATE_KINDS}. */
function isGateKind(kind: string): kind is GateKind {
  return (GATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Parse a `<kind>:<id>` gate string. Returns `null` when the string is malformed
 * (no colon, an empty kind before the colon, or an empty id after it) OR when the
 * kind is not a recognized {@link GateKind} — fail closed, never a partial parse.
 *
 * @param gate - The raw `<kind>:<id>` gate string.
 * @returns The parsed gate, or `null` when malformed/unknown.
 */
export function parseGate(gate: string): ParsedGate | null {
  const colon = gate.indexOf(":");
  if (colon <= 0 || colon === gate.length - 1) return null;
  const kind = gate.slice(0, colon);
  if (!isGateKind(kind)) return null;
  return { kind, id: gate.slice(colon + 1) };
}

/**
 * True when `gate` is a `trust:` gate — the cheap prefix check the write/advance
 * paths use to recognize a trust gate without a full {@link parseGate}. An
 * `undefined` gate (a stage with no gate) is not a trust gate.
 *
 * @param gate - The raw gate string, or `undefined` for a gate-less stage.
 * @returns Whether the gate is a `trust:` gate.
 */
export function isTrustGate(gate: string | undefined): boolean {
  return gate?.startsWith(TRUST_GATE_PREFIX) ?? false;
}
