/**
 * Structural admission for versioned answer proposals and citation manifests.
 * Validate raw metadata before legacy sanitization can erase an invalid field.
 * These audit observations never substitute for fresh publication validation.
 */
import { isSafeFilenameComponent } from "../profile/identity.js";
import { slugify } from "../utils/markdown.js";
import type { AnswerCitation } from "./answer-types.js";

/** Exclusive discriminator for reviewed generated answers. */
export type ValidatedAnswerKind = { name: "validated-answer"; version: 1 };

/** Proposal-time audit of the canonical parsed body, not publication authority. */
export interface AnswerCitationManifest {
  version: 1;
  bodyDigest: string;
  citations: AnswerCitation[];
}

/** Typed diagnostic retained by targeted reads and rendered by queue warnings. */
export class InvalidCandidateMetadataError extends Error {
  constructor(readonly candidateId: string, reason: string) {
    super(`InvalidCandidateMetadata: ${candidateId}: ${reason}`);
    this.name = "InvalidCandidateMetadataError";
  }
}

/** A JSON record, excluding null and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Require the exact fields of a versioned union member. */
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Accept only supported retained default-page identities. */
function isPageId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const [directory, slug, ...rest] = value.split("/");
  // Retained identities preserve raw filename stems, including spaces and case.
  return (directory === "concepts" || directory === "queries") && rest.length === 0
    && typeof slug === "string" && slug.length > 0 && !/[\\\0]/.test(slug) && slug !== "." && slug !== "..";
}

/** Pending identities use the reporter's unique, sorted safe filename ids. */
function isCandidateIds(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((id, index) => typeof id === "string" && isSafeFilenameComponent(id)
      && (index === 0 || value[index - 1] < id));
}

/** Check an observation without normalizing or dropping malformed fields. */
function isCitation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.target !== "string" || slugify(value.target) !== value.target) return false;
  if (value.status === "broken") return exactKeys(value, ["target", "status"]);
  if (value.status === "resolved") return exactKeys(value, ["target", "status", "pageId"]) && isPageId(value.pageId);
  if (value.status === "pending") return exactKeys(value, ["target", "status", "candidateIds"]) && isCandidateIds(value.candidateIds);
  return false;
}

/** Require one supported, losslessly represented manifest. */
function isManifest(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["version", "bodyDigest", "citations"])) return false;
  if (value.version !== 1 || typeof value.bodyDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.bodyDigest)) return false;
  if (!Array.isArray(value.citations) || !value.citations.every(isCitation)) return false;
  return new Set(value.citations.map(citation => citation.target)).size === value.citations.length;
}

/** Validate exclusive kind, manifest, destination and file identity before admission. */
export function assertAnswerCandidateMetadata(value: unknown, fileId: string): void {
  if (!isRecord(value)) return;
  const hasKind = Object.hasOwn(value, "candidateKind");
  const hasManifest = Object.hasOwn(value, "citationManifest");
  if (!hasKind && !hasManifest) return;
  const refuse = (reason: string): never => { throw new InvalidCandidateMetadataError(fileId, reason); };
  const kind = value.candidateKind;
  if (!hasKind || !isRecord(kind) || !exactKeys(kind, ["name", "version"])
    || kind.name !== "validated-answer" || kind.version !== 1) refuse("unsupported candidate kind");
  if (!hasManifest || !isManifest(value.citationManifest)) refuse("missing or malformed citation manifest");
  if (typeof value.id !== "string" || !isSafeFilenameComponent(value.id) || value.id !== fileId) refuse("invalid candidate file identity");
  if (value.targetDirectory !== "queries" || value.reviewMode !== "forced"
    || !Array.isArray(value.sources) || value.sources.length !== 0
    || ["targetEntityType", "connectorProvenance", "sourceStates"].some(key => Object.hasOwn(value, key))) {
    refuse("validated answers require exclusive queries destination, forced review and empty sources");
  }
}
