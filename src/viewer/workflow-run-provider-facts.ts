/**
 * @file src/viewer/workflow-run-provider-facts.ts
 * @description Validation of a live-projection provider's verified-facts payload into a
 * PROVIDER-INDEPENDENT snapshot. The provider is untrusted JavaScript: every field is read
 * ONCE, bounded (string length, array length, content-address grammar), and copied into
 * fresh primitives/arrays, so the projection never re-reads a provider-owned value at
 * emission and a value past a bound degrades the whole stage (fail-closed). Split out of
 * the projection module, which owns the anchor contract and the request-time build.
 */

import type {
  StageOutputRef, VerifiedExperimentStateV1, VerifiedFactPanelV1,
  VerifiedFactRowV1, VerifiedStageFactsV1,
} from "./workflow-run-projection.js";
import { snapshotOptionalExperimentState } from "./compat/experiment-state.js";

/** Bounds on a provider's verified-facts payload (fail-closed: a value past a bound degrades). */
const MAX_STAGE_STRING_LEN = 4_000;
const MAX_STAGE_ARRAY_LEN = 1_024;
const MAX_FACT_TITLE_LEN = 120;
const MAX_FACT_LABEL_LEN = 120;
const MAX_FACT_ROWS = 32;
/** The one generic content-address grammar core enforces — on a member ref's `sha256`. */
const CONTENT_ADDRESS = /^sha256:[0-9a-f]{64}$/;
const FACT_TONES = new Set(["neutral", "success", "warning", "danger"]);

/** A non-empty, length-bounded string. */
function isBoundedString(value: unknown, max = MAX_STAGE_STRING_LEN): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** A validated, PROVIDER-INDEPENDENT snapshot of one stage's verified facts (fresh primitives/arrays). */
export interface NormalizedFacts {
  readonly stageId: string;
  readonly summary: string;
  readonly appliedTargets: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly groundedRefs?: readonly string[];
  readonly pdfRef?: StageOutputRef & { readonly member: string };
  readonly experimentState?: VerifiedExperimentStateV1;
  readonly factPanel?: VerifiedFactPanelV1;
}

/**
 * Read a provider array EXACTLY ONCE into a fresh array (defeating a stateful iterator/proxy),
 * then return that snapshot iff it is bounded with non-empty, non-duplicate string items.
 */
function snapshotUniqueStrings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const snapshot = [...value]; // single read of the (possibly stateful) source
  if (snapshot.length > MAX_STAGE_ARRAY_LEN) return null;
  const seen = new Set<string>();
  for (const item of snapshot) {
    if (!isBoundedString(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return snapshot as readonly string[];
}

/** Read a provider pdfRef's fields ONCE; return a fresh closed ref iff every field is well-formed. */
function snapshotPdfRef(value: unknown): (StageOutputRef & { member: string }) | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as Record<string, unknown>;
  const artifactType = ref.artifactType, slug = ref.slug, sha256 = ref.sha256, member = ref.member; // read ONCE
  if (!isBoundedString(artifactType) || !isBoundedString(slug) || !isBoundedString(member)) return null;
  if (typeof sha256 !== "string" || !CONTENT_ADDRESS.test(sha256)) return null;
  return { artifactType, slug, sha256, member };
}

/** undefined = field absent (ok); null = present-but-invalid (reject); value = a fresh snapshot. */
function snapshotOptionalStrings(raw: unknown): readonly string[] | null | undefined {
  return raw === undefined ? undefined : snapshotUniqueStrings(raw);
}

/** undefined = absent (ok); null = present-but-invalid (reject); value = a fresh closed ref. */
function snapshotOptionalPdf(raw: unknown): (StageOutputRef & { member: string }) | null | undefined {
  return raw === undefined ? undefined : snapshotPdfRef(raw);
}

/** Snapshot one bounded fact row with a closed visual tone. */
function snapshotFactRow(value: unknown): VerifiedFactRowV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const label = raw.label, rowValue = raw.value, tone = raw.tone;
  if (!isBoundedString(label, MAX_FACT_LABEL_LEN) || !isBoundedString(rowValue)
    || typeof tone !== "string" || !FACT_TONES.has(tone)) return null;
  return { label, value: rowValue, tone: tone as VerifiedFactRowV1["tone"] };
}

/** Snapshot one generic bounded fact panel. */
function snapshotFactPanel(value: unknown): VerifiedFactPanelV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = raw.title, sourceRows = raw.rows;
  if (!isBoundedString(title, MAX_FACT_TITLE_LEN) || !Array.isArray(sourceRows)) return null;
  const rows = [...sourceRows];
  if (rows.length === 0 || rows.length > MAX_FACT_ROWS) return null;
  const normalized = rows.map(snapshotFactRow);
  if (normalized.some((row) => row === null)) return null;
  return { title, rows: normalized as VerifiedFactRowV1[] };
}

/** Snapshot + validate the REQUIRED verified-facts fields (each read ONCE) into fresh values, or null. */
function snapshotRequiredFacts(
  facts: VerifiedStageFactsV1,
): Pick<NormalizedFacts, "stageId" | "summary" | "appliedTargets" | "evidenceDigests"> | null {
  const stageId = facts.stageId, summary = facts.summary; // read ONCE
  const appliedTargets = snapshotUniqueStrings(facts.appliedTargets);
  const evidenceDigests = snapshotUniqueStrings(facts.evidenceDigests);
  if (!isBoundedString(stageId) || !isBoundedString(summary) || appliedTargets === null || evidenceDigests === null) {
    return null;
  }
  return { stageId, summary, appliedTargets, evidenceDigests };
}

/**
 * Validate AND normalize one provider stage into a fresh {@link NormalizedFacts} in a SINGLE
 * pass — every provider-owned value is read exactly once into a provider-independent snapshot,
 * so a stateful array/getter/proxy cannot pass validation and then emit different forged data
 * (the check/use TOCTOU). Returns null on any malformed field. Product-specific identity grammar
 * for the arrays stays the product's job; core enforces bounds, non-emptiness, uniqueness (+ the
 * sha256 ref grammar).
 */
export function normalizeVerifiedFacts(facts: VerifiedStageFactsV1): NormalizedFacts | null {
  const required = snapshotRequiredFacts(facts);
  const groundedRefs = snapshotOptionalStrings(facts.groundedRefs);
  const pdfRef = snapshotOptionalPdf(facts.pdfRef);
  const experimentState = snapshotOptionalExperimentState(facts.experimentState);
  const rawFactPanel = facts.factPanel;
  const factPanel = rawFactPanel === undefined ? undefined : snapshotFactPanel(rawFactPanel);
  if (required === null || groundedRefs === null || pdfRef === null
    || experimentState === null || factPanel === null) return null;
  return { ...required,
    ...(groundedRefs === undefined ? {} : { groundedRefs }), ...(pdfRef === undefined ? {} : { pdfRef }),
    ...(experimentState === undefined ? {} : { experimentState }),
    ...(factPanel === undefined ? {} : { factPanel }) };
}
