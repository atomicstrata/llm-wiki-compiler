/**
 * Pure rules of the source review cockpit: the plain-language verdict on a
 * proposal's checks, the copyable terminal command, and the metadata block
 * split off a page's text. Matching bytes never imply editorial approval,
 * so every message says what still needs a human.
 */
import type { SourceChangeCandidate, SourceChangeOwner, SourceExcerpt } from "./api";

/** Refusal-grade target problems, kept in the always-visible explanation. */
const TARGET_REASONS: Record<string, string> = {
  "changed or unreadable": "the wiki page changed or could not be read",
  "expected absent; present or unreadable": "the proposal expected no wiki page, but one exists or its absence cannot be confirmed",
  "invalid expectations": "the proposal contains contradictory wiki-page expectations",
  "invalid binding": "the proposal’s saved wiki-page fingerprint is invalid",
};

/** Target checks that raise no warning. */
const TARGET_CLEAR = new Set(["matches", "expected absence observed"]);

const MATCHES = "The source versions and wiki-page checks match the proposal’s recorded expectations. You still need to review the content; this is not an approval.";

function targetWarning(check: string): string {
  const reason = TARGET_REASONS[check];
  if (reason !== undefined) return `Do not apply this proposal yet: ${reason}.`;
  if (TARGET_CLEAR.has(check)) return "";
  return "This proposal is not approved. We cannot confirm it was prepared for the current wiki page.";
}

/** Source problems stay visible even when the proposal has no target binding. */
function sourceWarning(check: string): string {
  if (check === "matches") return "";
  if (check === "changed or unavailable") return "Do not apply this proposal yet: a source changed or is unavailable. Review it against the current sources.";
  return "This proposal is not approved. We cannot confirm that it covers the current versions of all its sources.";
}

/** The verdict on one proposal's checks; a clean pair still says review is needed. */
export function reviewMessage(candidate: SourceChangeCandidate): string {
  const warnings = [targetWarning(candidate.checks.target), sourceWarning(candidate.checks.sources)].filter((text) => text.length > 0);
  return warnings.length > 0 ? warnings.join(" ") : MATCHES;
}

/** Control characters would let a path or id break out of the quoted command. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function isSafeShellValue(value: string | undefined): boolean {
  return value === undefined || (value.length > 0 && !CONTROL_CHARACTERS.test(value));
}

/** POSIX single quoting keeps a path or id from becoming shell syntax or an option. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The terminal command that inspects a proposal, or generates one; null when it could not be quoted safely. */
export function reviewCommand(root: string, id?: string): string | null {
  if (root.length === 0 || !isSafeShellValue(root) || !isSafeShellValue(id)) return null;
  const action = id === undefined ? "llmwiki compile --review" : `llmwiki review show -- ${shellQuote(id)}`;
  return `cd -- ${shellQuote(root)} &&\n${action}`;
}

/** The exact initial frontmatter bytes, delimiters included; empty when the text has none. */
export function metadataBlock(text: string | null): string {
  return text?.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
}

/** Ownership is metadata from state.json, never inferred from excerpt text. */
export function ownerStatus(excerpt: SourceExcerpt, owners: SourceChangeOwner[]): string {
  return owners.find((owner) => owner.file === excerpt.file)?.status ?? "unverified";
}
