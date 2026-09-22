/**
 * @file src/viewer/compat/experiment-state.ts
 * @description Archived scientific-provider presentation contract. This adapter
 * preserves the existing wire shape and validation without making scientific
 * lifecycle semantics part of the generic projection implementation. New
 * providers use bounded fact panels; this contract grants no workflow authority.
 */

/** @deprecated Compatibility for existing providers; use a generic factPanel. */
export interface VerifiedExperimentStateV1 {
  readonly hypothesis: string;
  readonly slug: string;
  readonly lifecycle: "designed" | "executing" | "result-recorded" | "judged";
  readonly verdict?: "supports" | "contradicts";
}

const MAX_EXPERIMENT_STRING_LEN = 4_000;
/** Allowed verdict values per closed lifecycle; non-judged states require absence. */
const LIFECYCLE_VERDICTS: Readonly<Record<string, readonly unknown[]>> = {
  designed: [undefined], executing: [undefined], "result-recorded": [undefined],
  judged: ["supports", "contradicts"],
};

/** True for a non-empty bounded compatibility string. */
function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EXPERIMENT_STRING_LEN;
}

/** Read each field once; absence is valid, malformed presence rejects the stage. */
export function snapshotOptionalExperimentState(value: unknown): VerifiedExperimentStateV1 | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const hypothesis = raw.hypothesis, slug = raw.slug, lifecycle = raw.lifecycle, verdict = raw.verdict;
  const allowedVerdicts = typeof lifecycle === "string" ? LIFECYCLE_VERDICTS[lifecycle] : undefined;
  const fieldsValid = [isBoundedString(hypothesis), isBoundedString(slug), allowedVerdicts?.includes(verdict) === true];
  if (!fieldsValid.every(Boolean)) return null;
  const base = { hypothesis, slug, lifecycle } as VerifiedExperimentStateV1;
  return verdict === undefined ? base : { ...base, verdict } as VerifiedExperimentStateV1;
}
