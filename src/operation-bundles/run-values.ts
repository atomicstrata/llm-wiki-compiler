/** Shared bounded run values; each store retains its own envelope and authority grammar. */
import { count, textValue, type JsonRecord } from "./manifest-values.js";

/** Parse one canonical millisecond UTC timestamp with the run-specific bound. */
export function canonicalTime(value: unknown, label: string): string {
  const parsed = textValue(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

/** Rebuild and validate counted warning fields after the caller checks the envelope. */
export function warningFields(obj: JsonRecord, maxCodeBytes: number) {
  const warning = {
    code: textValue(obj.code, "warning code", maxCodeBytes), attempted: count(obj.attempted, "warning attempted"),
    completed: count(obj.completed, "warning completed"), skipped: count(obj.skipped, "warning skipped"),
    failed: count(obj.failed, "warning failed"),
  };
  if (warning.attempted === 0) throw new Error("completion warning requires a positive attempted count");
  if (warning.attempted !== warning.completed + warning.skipped + warning.failed) {
    throw new Error("completion warning counts are inconsistent");
  }
  return warning;
}
