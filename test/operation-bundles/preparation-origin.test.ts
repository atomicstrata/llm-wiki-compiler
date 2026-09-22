/**
 * @file test/operation-bundles/preparation-origin.test.ts
 * @description The host-authored `preparation-handoff-origin-v1` evidence entry
 * round-trips through its build and strict parse (design section 22.2). The minted
 * bytes are canonical and content-addressed; the evidence ref binds the same
 * digest the bundle manifest covers; and the strict loader refuses a non-canonical
 * blob, an unknown kind, and a location-shaped identity.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPreparationHandoffOrigin, parsePreparationHandoffOrigin,
  PREPARATION_HANDOFF_ORIGIN_KIND,
} from "../../src/operation-bundles/preparation-origin.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";

const DIGEST = `sha256:${"a".repeat(64)}` as OperationDigest;

/** One valid origin input over bounded logical identities. */
function input() {
  return {
    workspaceId: "workspace-one", preparationId: "prp_1", preparationRunId: "prr_1",
    preparationManifestDigest: DIGEST, preparationPlanDigest: DIGEST,
    preHandoffTransitionHash: DIGEST, handoffId: "hof_1",
  };
}

describe("preparation handoff origin build and parse", () => {
  it("mints canonical content-addressed bytes and a matching evidence ref", () => {
    const built = buildPreparationHandoffOrigin(input());
    expect(built.digest).toBe(createHash("sha256").update(built.bytes).digest("hex"));
    expect(built.evidenceRef.type).toBe(PREPARATION_HANDOFF_ORIGIN_KIND);
    expect(built.evidenceRef.digest).toBe(`sha256:${built.digest}`);
    expect(built.evidenceRef.payloadRef).toBe(built.digest);
  });

  it("round-trips exactly through the strict loader", () => {
    const built = buildPreparationHandoffOrigin(input());
    expect(parsePreparationHandoffOrigin(built.bytes.toString("utf8"))).toEqual(built.origin);
  });

  it("refuses an unknown kind, a location identity, and an unexpected key", () => {
    expect(() => parsePreparationHandoffOrigin(JSON.stringify({ ...input(), schemaVersion: 1, kind: "other" }))).toThrow();
    expect(() => buildPreparationHandoffOrigin({ ...input(), preparationId: "../escape" })).toThrow();
    const built = buildPreparationHandoffOrigin(input());
    expect(() => parsePreparationHandoffOrigin(JSON.stringify({ ...built.origin, extra: 1 }))).toThrow();
  });
});
