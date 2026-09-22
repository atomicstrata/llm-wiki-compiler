/**
 * @file Closed data-only admission for one entity create/update intent. Captures
 * exact caller bytes synchronously; it performs no IO and grants no authority.
 * Profile/target validity and current preimages are separately checked under the
 * project lock by preparation. All digests here use the operation SHA-256 prefix.
 */
import { assertSlugSafe } from "../profile/identity.js";
import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";
import { digest, textValue } from "./manifest-values.js";
import { assertWorkspaceId } from "./paths.js";
import type { OperationDigest } from "./types.js";

const MAX_RECORD_BODY_BYTES = 1024 * 1024;

/** Exact proposed record bytes and non-authoritative source attribution. */
export interface RecordIntentV1 {
  schema: "llmwiki-record-intent-v1";
  workspaceId: string;
  effectId: string;
  profileDigest: OperationDigest;
  target: { entityType: string; slug: string };
  precondition: { kind: "absent" } | { kind: "digest"; digest: OperationDigest };
  proposedBody: string;
  origin: { provider: string; runId: string; occurrenceId: string; proposalDigest: OperationDigest };
}

/** Capture only a closed own-data object; never evaluate caller accessors. */
export function dataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record-intent-invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("record-intent-invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new Error("record-intent-invalid");
  }
  const captured: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) throw new Error("record-intent-invalid");
    captured[field] = descriptor.value;
  }
  return captured;
}

/** Decode the discriminant by descriptor before selecting its exact fields. */
function precondition(value: unknown): RecordIntentV1["precondition"] {
  const kind = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
  if (kind === "absent") { dataRecord(value, ["kind"]); return { kind }; }
  if (kind !== "digest") throw new Error("record-intent-invalid");
  const captured = dataRecord(value, ["kind", "digest"]);
  return { kind, digest: digest(captured.digest, "precondition") };
}

/** Preserve literal line endings and characters; reject lossy UTF-8 encodings. */
function body(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > MAX_RECORD_BODY_BYTES ||
    !isWellFormedUnicode(value) || Buffer.byteLength(value, "utf8") > MAX_RECORD_BODY_BYTES) {
    throw new Error("record-intent-invalid");
  }
  return value;
}

/** Return a fresh intent containing no caller-owned nested aliases. */
export function captureRecordIntent(value: unknown): RecordIntentV1 {
  const input = dataRecord(value, ["schema", "workspaceId", "effectId", "profileDigest", "target", "precondition", "proposedBody", "origin"]);
  if (input.schema !== "llmwiki-record-intent-v1") throw new Error("record-intent-invalid");
  const target = dataRecord(input.target, ["entityType", "slug"]);
  const origin = dataRecord(input.origin, ["provider", "runId", "occurrenceId", "proposalDigest"]);
  return {
    schema: "llmwiki-record-intent-v1", workspaceId: assertWorkspaceId(input.workspaceId),
    effectId: textValue(input.effectId, "effectId"), profileDigest: digest(input.profileDigest, "profileDigest"),
    target: { entityType: assertSlugSafe(textValue(target.entityType, "entityType")),
      slug: assertSlugSafe(textValue(target.slug, "slug")) },
    precondition: precondition(input.precondition), proposedBody: body(input.proposedBody),
    origin: { provider: textValue(origin.provider, "provider"), runId: textValue(origin.runId, "runId"),
      occurrenceId: textValue(origin.occurrenceId, "occurrenceId"), proposalDigest: digest(origin.proposalDigest, "proposalDigest") },
  };
}

/** Domain-separated digest binds every intent field, including its effect ID. */
export function recordIntentDigest(intent: RecordIntentV1): OperationDigest {
  return canonicalDigest({ domain: "llmwiki.record-intent.v1", intent }) as OperationDigest;
}
