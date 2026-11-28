/**
 * @file test/scale/plan.test.ts
 * @description Expected-scale planning: exact size and count parsing (units,
 * fractions, overflow, ambiguity), derived versus stated documents, the
 * planning-policy architectures for about 100 documents, the local envelope and
 * beyond, the internal consistency of the documented assumptions with the
 * code's own hard format caps, and the conservative preflight requirement.
 */

import { describe, expect, it } from "bun:test";
import {
  AVERAGE_DOCUMENT_BYTES, BYTES_PER_EMBEDDING_ENTRY, EMBEDDING_ENTRIES_PER_DOCUMENT, LOCAL_MAX_BYTES, LOCAL_MAX_DOCUMENTS,
  PREFLIGHT_HEADROOM_BYTES, STANDARD_MAX_BYTES, STANDARD_MAX_DOCUMENTS, ScaleRefusalError,
} from "../../src/scale/contracts.js";
import {
  needsTransition, parseDocumentCount, parseSizeBytes, planRecorded, planScale, preflightRequiredBytes, validateRequest,
} from "../../src/scale/plan.js";
import { MAX_EMBEDDING_ENTRIES, MAX_EMBEDDING_STORE_BYTES } from "../../src/utils/constants.js";
import { MAX_BINARY_STORE_BYTES } from "../../src/utils/embeddings-binary.js";

/** The refusal code a call throws. */
function refusalOf(call: () => unknown): string | undefined {
  try { call(); } catch (error) { return error instanceof ScaleRefusalError ? error.code : "other"; }
  return undefined;
}

describe("parsing an expected size and document count", () => {
  it("parses decimal and binary units, whole-byte fractions and bare bytes exactly", () => {
    expect([parseSizeBytes("5MB"), parseSizeBytes("2.5GB"), parseSizeBytes("150 MiB"), parseSizeBytes("1048576"), parseSizeBytes("1kib")])
      .toEqual([5_000_000, 2_500_000_000, 150 * 1024 * 1024, 1_048_576, 1024]);
    expect(parseSizeBytes("2TB")).toBe(2_000_000_000_000);
    expect(parseDocumentCount(" 100 ")).toBe(100);
  });

  it("refuses ambiguous, fractional, zero, negative, non-finite and unsafe values", () => {
    for (const text of ["", "abc", "-5MB", "0", "0.5", "1.5B", "5 XB", "Infinity", "NaN", "1e9", "5MB extra", "99999999999999999999TB"]) {
      expect(refusalOf(() => parseSizeBytes(text)), text).toBe("scale_invalid_request");
    }
    for (const text of ["", "0", "-1", "1.5", "1e3", "9007199254740992"]) {
      expect(refusalOf(() => parseDocumentCount(text)), text).toBe("scale_invalid_request");
    }
  });

  it("validates numeric SDK requests as positive safe integers, keeping only known fields", () => {
    for (const bad of [{ sizeBytes: 0 }, { sizeBytes: 1.5 }, { sizeBytes: Number.NaN }, { sizeBytes: 2 ** 53 }, { sizeBytes: 5, documents: 0 }, {}, null]) {
      expect(refusalOf(() => validateRequest(bad as never))).toBe("scale_invalid_request");
    }
    expect(validateRequest({ sizeBytes: 5, documents: 2, extra: true } as never)).toEqual({ sizeBytes: 5, documents: 2 });
  });
});

describe("planning an estimate", () => {
  it("plans about 100 documents as local-standard with nothing to prepare", () => {
    const plan = planScale({ sizeBytes: 5_000_000, documents: 100 });
    expect(plan).toEqual({ requested: { sizeBytes: 5_000_000, documents: 100, sizeBasis: "stated", documentsBasis: "stated" }, architecture: "local-standard", exceeds: [] });
    expect(needsTransition("local-standard", plan.architecture)).toBe(false);
  });

  it("derives documents from bytes, plans the local envelope as local-large, and beyond it as unavailable", () => {
    expect(planScale({ sizeBytes: 3 * AVERAGE_DOCUMENT_BYTES }).requested).toEqual({ sizeBytes: 3 * AVERAGE_DOCUMENT_BYTES, documents: 3, sizeBasis: "stated", documentsBasis: "derived" });
    expect(planScale({ sizeBytes: STANDARD_MAX_BYTES + 1 }).architecture).toBe("local-large");
    expect(planScale({ sizeBytes: 1000, documents: LOCAL_MAX_DOCUMENTS }).architecture).toBe("local-large");
    expect(planScale({ sizeBytes: parseSizeBytes("2TB") })).toMatchObject({ architecture: "unavailable", exceeds: ["documents", "bytes"] });
    expect(planScale({ sizeBytes: 1000, documents: LOCAL_MAX_DOCUMENTS + 1 }).exceeds).toEqual(["documents"]);
    expect(needsTransition("local-large", "local-standard")).toBe(false);
  });

  it("plans a document count alone, deriving bytes conservatively and refusing an unsafe derivation", () => {
    expect(planScale({ documents: 100 })).toEqual({
      requested: { sizeBytes: 100 * AVERAGE_DOCUMENT_BYTES, documents: 100, sizeBasis: "derived", documentsBasis: "stated" },
      architecture: "local-standard", exceeds: [],
    });
    expect(planScale({ documents: STANDARD_MAX_DOCUMENTS + 1 }).architecture).toBe("local-large");
    expect(refusalOf(() => planScale({ documents: Number.MAX_SAFE_INTEGER }))).toBe("scale_invalid_request");
  });

  it("re-plans a recorded estimate on its recorded basis", () => {
    const derived = planScale({ sizeBytes: 10 * AVERAGE_DOCUMENT_BYTES }).requested;
    expect(planRecorded(derived).requested.documentsBasis).toBe("derived");
    expect(planRecorded({ ...derived, documentsBasis: "stated" }).requested.documentsBasis).toBe("stated");
  });
});

describe("the planning policy's own arithmetic", () => {
  it("keeps every threshold inside the format caps under the documented assumptions", () => {
    const entryBytes = EMBEDDING_ENTRIES_PER_DOCUMENT * BYTES_PER_EMBEDDING_ENTRY;
    expect(STANDARD_MAX_DOCUMENTS * entryBytes).toBeLessThanOrEqual(MAX_EMBEDDING_STORE_BYTES);
    expect(LOCAL_MAX_DOCUMENTS * entryBytes).toBeLessThanOrEqual(MAX_BINARY_STORE_BYTES);
    expect(LOCAL_MAX_DOCUMENTS * EMBEDDING_ENTRIES_PER_DOCUMENT).toBeLessThanOrEqual(MAX_EMBEDDING_ENTRIES);
    expect([STANDARD_MAX_BYTES, LOCAL_MAX_BYTES]).toEqual([STANDARD_MAX_DOCUMENTS * AVERAGE_DOCUMENT_BYTES, LOCAL_MAX_DOCUMENTS * AVERAGE_DOCUMENT_BYTES]);
  });

  it("requires the full conservative estimate plus headroom, never less than the sources themselves", () => {
    const requested = planScale({ sizeBytes: 100 * 1024 * 1024, documents: 2_000 }).requested;
    const embeddings = 2_000 * EMBEDDING_ENTRIES_PER_DOCUMENT * BYTES_PER_EMBEDDING_ENTRY;
    expect(preflightRequiredBytes(requested)).toBe(requested.sizeBytes * 2 + embeddings * 2 + PREFLIGHT_HEADROOM_BYTES);
    expect(preflightRequiredBytes({ sizeBytes: Number.MAX_SAFE_INTEGER, documents: 1, sizeBasis: "stated", documentsBasis: "stated" })).toBe(Number.MAX_SAFE_INTEGER);
  });
});
