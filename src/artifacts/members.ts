/**
 * @file src/artifacts/members.ts
 * @description The member MANIFEST of a member-bearing artifact type: the ONE
 * schema validator (shared by the write plan and read resolution, exactly like
 * `body-contract.ts`, so a manifest valid when written MUST verify on read) and
 * the ONE canonical builder (core derives the manifest from supplied member
 * bytes — no caller-supplied digest, count, or manifest text exists on the
 * write path, so a forged entry has no channel).
 *
 * MANIFEST SHAPE: `{ "members": [ { "fileName", "sha256", "bytes" }, … ] }` —
 * exactly those keys, entries SORTED strictly ascending by fileName (canonical
 * bytes: two orderings of one member set must not mint two hashes), names safe
 * flat leaves that are never RESERVED (the declared file, anything ending
 * `.manifest.json`, dotfiles), 64-hex digests, safe non-negative byte counts,
 * count and overflow-checked total within the declared ceilings, and the
 * declared name policy (allowed extensions, required names, exact names)
 * satisfied. Pure, no I/O, path-free messages (empty = valid).
 */

import { createHash } from "node:crypto";
import { isSafeFilenameComponent } from "../profile/identity.js";
import type { ArtifactMembersDef, ArtifactTypeDef } from "../profile/types.js";

/** One manifest row: a member leaf's name, content digest, and byte count. */
export interface ArtifactMemberEntry {
  fileName: string;
  sha256: string;
  bytes: number;
}

/** A member supplied to a write: its leaf name and raw bytes (core hashes them). */
export interface ArtifactMemberFileInput {
  fileName: string;
  bytes: Uint8Array;
}

/** The sidecar suffix every artifact leaf's manifest carries — reserved for members. */
export const ARTIFACT_SIDECAR_SUFFIX = ".manifest.json";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = ["fileName", "sha256", "bytes"] as const;

/**
 * The ALIAS identity of a leaf name: NFC-normalized, then CASE-FOLDED via the
 * down-up-down round trip. Two names with one alias key may be ONE physical
 * file on a case-insensitive or normalizing filesystem (macOS both), so
 * uniqueness and reservation are judged on the alias key — a manifest naming
 * `A.tex` and `a.tex` would list two rows over one leaf, and `BUNDLE.JSON`
 * would shadow the declared file.
 *
 * `toLowerCase()` ALONE is not the filesystem's fold: MICRO SIGN µ (U+00B5)
 * and GREEK MU μ (U+03BC) stay distinct under it, yet APFS/HFS+ fold them to
 * one leaf — so a fold-only rename classified the old spelling obsolete and
 * the write deleted the member it had just written through the shared leaf.
 * A single up-down trip regressed ẞ/ß (ß upper-cases to "SS" while ẞ stays
 * ẞ, so their keys diverged); the DOWN-up-down trip sends both through ß →
 * "SS" → "ss", and the tested collision classes (µ/μ, ς/σ, K/k, ſ/s, ß/ss,
 * ẞ/ß) all collapse. This is the closure reachable with deterministic
 * built-in case mappings — NOT a claim of equivalence with Unicode case
 * folding or any particular filesystem's tables. Over-folding is safe by
 * construction: alias EQUALITY only ever refuses, and obsolete classification
 * requires INEQUALITY, so a too-wide key can only shrink the obsolete set.
 * The post-commit re-resolve in apply-members.ts is the backstop for any pair
 * a filesystem folds that this key still misses.
 */
export function memberAliasKey(name: string): string {
  return name.normalize("NFC").toLowerCase().toUpperCase().toLowerCase();
}
const aliasKey = memberAliasKey;

/** The lower-cased extension of a leaf name, or "" when it has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}

/** A name no member may take (alias-insensitively): the declared file, any sidecar, or a dotfile. */
export function isReservedMemberName(def: Pick<ArtifactTypeDef, "fileName">, name: string): boolean {
  const key = aliasKey(name);
  return key === aliasKey(def.fileName) || key.endsWith(ARTIFACT_SIDECAR_SUFFIX) || name.startsWith(".");
}

/** Violations of the declared NAME policy over a proposed member-name set. */
export function memberNamePolicyViolations(members: ArtifactMembersDef, names: readonly string[]): string[] {
  const problems: string[] = [];
  const allowed = members.allowedExtensions?.map((ext) => ext.toLowerCase());
  for (const name of names) {
    if (allowed !== undefined && !allowed.includes(extensionOf(name))) {
      problems.push(`member ${JSON.stringify(name)} has an extension outside the allowed set ${JSON.stringify(allowed)}`);
    }
  }
  const required = members.requiredNames ?? [];
  for (const name of required) {
    if (!names.includes(name)) problems.push(`required member ${JSON.stringify(name)} is missing`);
  }
  if (members.exactNames === true) {
    for (const name of names) {
      if (!required.includes(name)) problems.push(`member ${JSON.stringify(name)} is outside the exact required set`);
    }
  }
  return problems;
}

/** The fileName violation of one entry, or null. */
function nameViolation(def: ArtifactTypeDef, fileName: unknown, index: number): string | null {
  if (typeof fileName !== "string" || !isSafeFilenameComponent(fileName)) return `members[${index}].fileName is not a safe flat leaf name`;
  if (isReservedMemberName(def, fileName)) return `members[${index}].fileName ${JSON.stringify(fileName)} is reserved`;
  return null;
}

/** The byte-count violation of one entry, or null. */
function bytesViolation(members: ArtifactMembersDef, bytes: unknown, index: number): string | null {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return `members[${index}].bytes is not a safe non-negative integer`;
  if (bytes > members.maxMemberBytes) return `members[${index}].bytes ${bytes} exceeds maxMemberBytes ${members.maxMemberBytes}`;
  return null;
}

/** Structural violations of ONE manifest entry (name grammar, digest, byte count). */
function entryViolations(def: ArtifactTypeDef, members: ArtifactMembersDef, raw: unknown, index: number): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`members[${index}] is not an object`];
  const keys = Object.keys(raw).sort();
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every((key) => keys.includes(key))) {
    return [`members[${index}] must carry exactly the keys ${JSON.stringify(ENTRY_KEYS)}`];
  }
  const { fileName, sha256, bytes } = raw as Record<string, unknown>;
  const digestProblem = typeof sha256 === "string" && SHA256_HEX.test(sha256)
    ? null : `members[${index}].sha256 is not a lowercase sha256 hex digest`;
  return [nameViolation(def, fileName, index), digestProblem, bytesViolation(members, bytes, index)]
    .filter((problem): problem is string => problem !== null);
}

/** Ordering, count, ALIAS-uniqueness, and overflow-checked total over structurally valid entries. */
function setViolations(members: ArtifactMembersDef, entries: readonly ArtifactMemberEntry[]): string[] {
  const problems: string[] = [];
  if (entries.length > members.maxCount) problems.push(`${entries.length} members exceed maxCount ${members.maxCount}`);
  if (new Set(entries.map((entry) => aliasKey(entry.fileName))).size !== entries.length) {
    problems.push("member names collide after case/unicode normalization — one physical file would carry two rows");
  }
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index > 0 && !(entries[index - 1]!.fileName < entry.fileName)) {
      problems.push(`members must be sorted strictly ascending by fileName (at ${JSON.stringify(entry.fileName)})`);
    }
    // Overflow-checked: a sum past the safe-integer range is a violation, never a wrap.
    if (total > Number.MAX_SAFE_INTEGER - entry.bytes) return [...problems, "member byte total overflows"];
    total += entry.bytes;
  }
  if (total > members.maxTotalBytes) problems.push(`member byte total ${total} exceeds maxTotalBytes ${members.maxTotalBytes}`);
  return problems;
}

/** Parse a manifest body's member rows WITHOUT validating them; null when not the manifest shape. */
export function parseMemberEntries(body: string): ArtifactMemberEntry[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.members)) return null;
  return record.members as ArtifactMemberEntry[];
}

/**
 * Violations of `def`'s member-manifest contract for `body` — the read-side
 * and write-side authority alike.
 *
 * @param def - A declared artifact type carrying `members`.
 * @param body - The manifest body bytes (UTF-8 JSON).
 * @returns Path-free violation messages; empty means valid.
 */
export function validateMemberManifestBody(def: ArtifactTypeDef, body: string): string[] {
  const members = def.members;
  if (members === undefined) return ["artifact type declares no members"];
  const rows = parseMemberEntries(body);
  if (rows === null) return ["manifest body must be a JSON object with exactly one key, \"members\", holding an array"];
  const problems = rows.flatMap((row, index) => entryViolations(def, members, row, index));
  if (problems.length > 0) return problems;
  return [...setViolations(members, rows), ...memberNamePolicyViolations(members, rows.map((row) => row.fileName))];
}

/** SHA-256 hex over raw bytes (the member digest). */
export function hashMemberBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One private copy of each member's bytes. Member inputs are CALLER-OWNED
 * mutable views; hashing one snapshot while later writing another would be a
 * forged-manifest channel, so the write authority snapshots ONCE up front and
 * both the derive and the write consume the same frozen bytes.
 */
export function snapshotMemberFiles(files: readonly ArtifactMemberFileInput[]): ArtifactMemberFileInput[] {
  return files.map((file) => ({ fileName: file.fileName, bytes: Uint8Array.from(file.bytes) }));
}

/** The canonical manifest built from supplied member bytes, or the reasons it cannot be. */
export type BuiltMemberManifest =
  | { ok: true; body: string; entries: ArtifactMemberEntry[] }
  | { ok: false; problems: string[] };

/**
 * Derive the canonical manifest for `files`: hash each member's bytes, sort by
 * fileName, render the fixed-key-order JSON, then run the SAME validator the
 * read side runs over the rendered body — so every ceiling and policy is
 * enforced in one place. Duplicate input names refuse before anything else.
 *
 * @param def - A declared artifact type carrying `members`.
 * @param files - The members to write (bytes only; nothing else is trusted).
 */
export function buildMemberManifest(def: ArtifactTypeDef, files: readonly ArtifactMemberFileInput[]): BuiltMemberManifest {
  const keys = files.map((file) => aliasKey(file.fileName));
  const duplicate = files.find((file, index) => keys.indexOf(aliasKey(file.fileName)) !== index);
  if (duplicate !== undefined) return { ok: false, problems: [`member ${JSON.stringify(duplicate.fileName)} is supplied more than once (names are compared case/unicode-insensitively)`] };
  const entries = files
    .map((file) => ({ fileName: file.fileName, sha256: hashMemberBytes(file.bytes), bytes: file.bytes.byteLength }))
    .sort((left, right) => (left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0));
  const body = JSON.stringify({ members: entries });
  const problems = validateMemberManifestBody(def, body);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, body, entries };
}
