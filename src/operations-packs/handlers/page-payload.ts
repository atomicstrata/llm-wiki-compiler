/**
 * @file src/operations-packs/handlers/page-payload.ts
 * @description THE page-payload convention, stated once: how an
 * `artifact-upsert` intent draft's scalar fields become the REAL page a wiki
 * profile can read back. A page store payload is frontmatter plus a body — a
 * raw canonical-JSON record is a page the profile collector cannot parse, so a
 * bootstrap that wrote one would POISON its own store: the next run's reconcile
 * snapshot refuses the malformed page and the product can never run over its
 * own output.
 *
 * The convention is generic and schema-free: the draft field named
 * {@link PAGE_BODY_FIELD} becomes the page BODY; every other field becomes a
 * frontmatter entry in sorted key order. A field named in the draft's
 * `listFields` is emitted as a ONE-element list — the closed evidence-scalar
 * grammar cannot carry a list, but a profile may REQUIRE one (an entity field
 * declared `string[]`), and the pack knows which of its fields those are, so
 * the hint travels on the intent GROUP rather than as profile-aware code here.
 * Values are emitted as JSON scalars, which are valid YAML — quoting and
 * escaping come for free and round-trip through the profile's own parser.
 *
 * `intent-compile` digests exactly these bytes into `payloadDigest`, and the
 * materializer recomputes them through this SAME function before authoring the
 * mutation — the shared formatter is what keeps the draft's published digest
 * and the applied page's content address one fact.
 */

import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import type { PackEvidenceScalarV1 } from "./types.js";

/** The draft field that becomes the page body rather than frontmatter. */
export const PAGE_BODY_FIELD = "content";

/** The slice of a draft this formatter reads. */
export interface PagePayloadDraftV1 {
  readonly fields: Readonly<Record<string, PackEvidenceScalarV1>>;
  readonly listFields?: readonly string[];
}

/** One frontmatter line: the key, and the value as a JSON scalar or one-element list. */
function frontmatterLine(key: string, value: PackEvidenceScalarV1, asList: boolean): string {
  const scalar = JSON.stringify(value);
  return `${key}: ${asList ? `[${scalar}]` : scalar}`;
}

/** Format one draft's fields as the page bytes the store writes and reads back. */
function formatPageBytes(draft: PagePayloadDraftV1): Buffer {
  const lists = new Set(draft.listFields ?? []);
  const lines = Object.keys(draft.fields)
    .filter((key) => key !== PAGE_BODY_FIELD)
    .sort()
    .map((key) => frontmatterLine(key, draft.fields[key]!, lists.has(key)));
  const body = String(draft.fields[PAGE_BODY_FIELD] ?? "");
  const trailed = body.length > 0 && !body.endsWith("\n") ? `${body}\n` : body;
  return Buffer.from(`---\n${lines.join("\n")}\n---\n${trailed}`, "utf8");
}

/** The slice of a draft the payload rule reads: kind, class, fields, hint. */
export interface DraftPayloadSourceV1 extends PagePayloadDraftV1 {
  readonly mutationKind: string;
  readonly targetProfileClass: string;
}

/**
 * THE payload-bytes rule, kind-dispatched and stated once: a PAGE draft's
 * payload — `artifact-upsert` or `artifact-update` alike — is the formatted PAGE
 * (the bytes the store writes and the profile reads back); every other kind's
 * payload is the canonical draft record
 * its mutation carries inline. `intent-compile` digests these bytes into
 * `payloadDigest`, the materializer recomputes them to authenticate each draft,
 * and the suites build fixtures through the same call — one rule, no drift.
 */
export function draftPayloadBytes(draft: DraftPayloadSourceV1): Buffer {
  // BOTH page kinds format as a page. An update whose payload fell through to
  // the canonical-JSON branch would be authored as a page write and would
  // OVERWRITE the markdown page with JSON.
  if (draft.mutationKind === "artifact-upsert" || draft.mutationKind === "artifact-update"
    || draft.mutationKind === "artifact-delete") {
    return formatPageBytes(draft);
  }
  return canonicalBytes({
    mutationKind: draft.mutationKind, targetProfileClass: draft.targetProfileClass, fields: draft.fields,
  });
}
