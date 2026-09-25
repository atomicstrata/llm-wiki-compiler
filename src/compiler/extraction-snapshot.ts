/**
 * Reusable extraction metadata for unchanged shared-page contributors.
 *
 * A snapshot is not a prompt-response cache: index growth alone deliberately
 * does not invalidate established concept assignments. New/changed sources
 * still extract against the current index. Snapshots enter state only with
 * fully published ownership and share the compile draft's atomic commit.
 * Missing, incompatible, or malformed snapshots fall back to fresh extraction.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { slugify } from "../utils/markdown.js";
import { getActiveProviderName, resolveActiveModelId } from "../utils/provider.js";
import type { ExtractedConcept, SourceState, SourceChange, WikiState } from "../utils/types.js";
import type { ExtractionResult } from "./deps.js";
import { buildExtractionPrompt, CONCEPT_EXTRACTION_TOOL, PROMPT_VERSION } from "./prompts.js";

const conceptSchema = z.object({
  concept: z.string().min(1), summary: z.string(), is_new: z.boolean(),
  tags: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional(),
  provenanceState: z.enum(["extracted", "merged", "inferred", "ambiguous", "imported"]).optional(),
  contradictedBy: z.array(z.object({ slug: z.string(), reason: z.string().optional() }).strict()).optional(),
  promptModifiers: z.array(z.string()).optional(),
}).strict();
const snapshotSchema = z.object({
  fingerprint: z.string(), sourceHash: z.string(), concepts: z.array(conceptSchema).min(1),
}).strict();

/** Hash the bytes actually supplied to extraction, not a later disk read. */
export function extractionSourceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Bind reuse to the extraction contract, language/policy, provider and model. */
function extractionFingerprint(): string {
  return extractionSourceHash(JSON.stringify([
    PROMPT_VERSION, getActiveProviderName(), resolveActiveModelId(),
    buildExtractionPrompt("", ""), CONCEPT_EXTRACTION_TOOL,
  ]));
}

/** Build the optional snapshot that is committed alongside live source state. */
export function snapshotExtraction(content: string, concepts: ExtractedConcept[]): NonNullable<SourceState["extraction"]> {
  return { fingerprint: extractionFingerprint(), sourceHash: extractionSourceHash(content), concepts };
}

/** Do not persist held or rejected assignments as reusable published metadata. */
export function withExtractionSnapshot(entry: SourceState, result: ExtractionResult, written: string[] = []): SourceState {
  const live = new Set(written);
  if (!result.concepts.every((concept) => live.has(slugify(concept.concept)))) return entry;
  return { ...entry, extraction: snapshotExtraction(result.sourceContent, result.concepts) };
}

/** Leave reconciliation and explicit requests on the original fresh path. */
export function reusableSourceFiles(
  state: WikiState, scoped: SourceChange[], detected: SourceChange[], review: boolean,
): Set<string> {
  if (review || state.frozenSlugs?.length || detected.some((change) => change.status === "deleted")) return new Set();
  const requested = new Set(scoped.filter((change) => change.status !== "unchanged").map((change) => change.file));
  return new Set(detected.filter((change) => change.status === "unchanged" && !requested.has(change.file)).map((change) => change.file));
}

/** Return validated metadata only when bytes, contract and live ownership match. */
export function reusableExtraction(entry: SourceState | undefined, content: string): ExtractedConcept[] | undefined {
  const parsed = snapshotSchema.safeParse(entry?.extraction);
  if (!parsed.success || !entry) return undefined;
  const snapshot = parsed.data;
  if (snapshot.fingerprint !== extractionFingerprint()) return undefined;
  if (snapshot.sourceHash !== entry.hash || snapshot.sourceHash !== extractionSourceHash(content)) return undefined;
  const slugs = new Set(snapshot.concepts.map((concept) => slugify(concept.concept)));
  if (slugs.size !== new Set(entry.concepts).size || entry.concepts.some((slug) => !slugs.has(slug))) return undefined;
  // Newness belongs to the current run, not the original extraction. Reused
  // assignments already have live ownership and must not inflate newConcepts.
  return snapshot.concepts.map((concept) => ({ ...concept, is_new: false }));
}
