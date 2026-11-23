/**
 * @file src/portable/scoped/scope.ts
 * @description The canonical form of a declared compile scope, and the checks
 * it must pass before anything is read or generated.
 *
 * Canonicalization is total: it never throws, so an intent digest can always
 * be taken over exactly what was asked for, and a malformed request is a
 * recorded refusal of its operation id, never an untyped error. Validation then refuses, as a
 * recorded outcome of the operation, any scope the host does not admit: a
 * malformed name, an empty or oversized source list, or a bound above the
 * host's ceiling. A refusal names no hidden content.
 */

import { PortableRefusal } from "../errors.js";
import { queryTerms } from "../scale/keyword-index.js";
import { SCOPED_HOST_CEILINGS, type CompileScopeV2, type ScopeBoundsV2 } from "./contracts.js";
import { isNamespaceName, isScopedSourceName } from "./namespaces.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a finite number (an integer check comes at admission). */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The bounds, when every declared bound is a number. Extra fields are not carried over. */
function boundsOf(value: unknown): ScopeBoundsV2 | null {
  if (!isRecord(value)) return null;
  const names: (keyof ScopeBoundsV2)[] = [
    "maxSources", "maxExpandedSources", "maxCandidates", "maxCandidateBytes", "maxSourceBytes", "maxReadBytes",
    "maxTitleEntries", "maxDependencies",
  ];
  if (!names.every((name) => isNumber(value[name]))) return null;
  return Object.fromEntries(names.map((name) => [name, value[name]])) as unknown as ScopeBoundsV2;
}

/** The context request, `null` when not opted in, or `undefined` when malformed. */
function contextOf(value: unknown): CompileScopeV2["context"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.query !== "string" || !isNumber(value.k) || !isNumber(value.scanBudget)) return undefined;
  return { query: value.query, k: value.k, scanBudget: value.scanBudget };
}

/** The digestible form of anything a caller sent, so even a malformed request has a stable intent. */
export function digestibleOf(value: unknown): unknown {
  try {
    return { malformed: JSON.parse(JSON.stringify(value ?? null)) as unknown };
  } catch {
    return { malformed: "unserializable" };
  }
}

/** The parts of any received scope, each `{}` or `null` when it is not of the declared kind. Total. */
export function scopeParts(input: unknown): {
  value: Record<string, unknown>; sources: Record<string, unknown>; namespace: Record<string, unknown>;
  names: string[] | null; bounds: ScopeBoundsV2 | null;
} {
  const value = isRecord(input) ? input : {};
  const sources = isRecord(value.sources) ? value.sources : {};
  const namespace = isRecord(value.namespace) ? value.namespace : {};
  const names = Array.isArray(sources.names) && sources.names.every((name) => typeof name === "string") ? sources.names as string[] : null;
  return { value, sources, namespace, names, bounds: boundsOf(value.bounds) };
}

/** True when `value` is a whole number from 1 to `ceiling`. */
function isWithin(value: unknown, ceiling: number, minimum = 1): boolean {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= ceiling;
}

/** True when every declared bound is a whole number within its ceiling in `ceilings`. */
export function boundsAdmitted(bounds: ScopeBoundsV2, ceilings: Readonly<ScopeBoundsV2> = SCOPED_HOST_CEILINGS): boolean {
  const names: (keyof ScopeBoundsV2)[] = [
    "maxSources", "maxCandidates", "maxCandidateBytes", "maxSourceBytes", "maxReadBytes", "maxTitleEntries", "maxDependencies",
  ];
  return names.every((name) => isWithin(bounds[name], ceilings[name]))
    && isWithin(bounds.maxExpandedSources, ceilings.maxExpandedSources, 0);
}

/** True when an opted-in context request is within the host's ceilings. */
function contextAdmitted(context: NonNullable<CompileScopeV2["context"]>): boolean {
  const terms = queryTerms(context.query).length;
  return terms >= 1 && terms <= SCOPED_HOST_CEILINGS.maxContextTerms
    && isWithin(context.k, SCOPED_HOST_CEILINGS.maxContextK)
    && isWithin(context.scanBudget, SCOPED_HOST_CEILINGS.maxContextScanBudget);
}

/**
 * Refuse a scope the host does not admit.
 *
 * @throws PortableRefusal `operation_unsupported_on_portable_path` for a malformed
 *   scope, `limit_exceeded` for one over the declared or host bounds.
 */
export function assertScopeAdmitted(scope: CompileScopeV2): void {
  const names = scope.sources.names;
  if (!isNamespaceName(scope.namespace.name) || names.length === 0 || !names.every(isScopedSourceName)) {
    throw new PortableRefusal(UNSUPPORTED, "malformed scope");
  }
  if (!boundsAdmitted(scope.bounds)) throw new PortableRefusal("limit_exceeded", "scope bounds");
  if (names.length > scope.bounds.maxSources) throw new PortableRefusal("limit_exceeded", "named sources");
  if (scope.context !== null && !contextAdmitted(scope.context)) throw new PortableRefusal("limit_exceeded", "context request");
}
