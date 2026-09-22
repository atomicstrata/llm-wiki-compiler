/**
 * @file test/preparations/reset-intent-contract.test.ts
 * @description The reset-intent marker's semantic contract, enforced at the parser.
 *
 * The marker is unsigned by design, so its grammar is the only structural check
 * between a planted or tampered file and a path that destroys preparation state. A
 * marker whose recorded confirmation contradicts its own reason is internally
 * inconsistent evidence: whichever field is honest, the other was forged. Validating
 * the fields independently — each well-formed, their RELATIONSHIP unchecked — let a
 * tampered marker through the continuation path even though supersession refused it.
 *
 * These tests pin the contract to the PARSER so every reader inherits it, rather than
 * to any one call site that happened to be audited.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import {
  buildResetIntent, parseResetIntent, resetContinuationDigest,
} from "../../src/preparations/receipts.js";
import {
  FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked,
} from "../../src/preparations/reset.js";
import { LIFECYCLE_ACTOR, stagePreparation } from "./lifecycle-fixture.js";
import { recordFirstPassIntent } from "./reset-intent-helpers.js";

const AT = "2026-07-20T05:00:00.000Z";
const UNIT = "rst-contractcontractcontractxxx";

/** A well-formed marker, with any single field overridable to a tampered value. */
const markerWith = (overrides: Record<string, unknown>) => canonicalBytes({
  ...buildResetIntent({
    unitId: UNIT, reason: "missing-key", confirmation: MISSING_KEY_CONFIRMATION,
    continuationDigest: resetContinuationDigest(randomBytes(32)), actor: LIFECYCLE_ACTOR, at: AT,
  }),
  ...overrides,
});

describe("reset-intent semantic grammar", () => {
  it("refuses a marker whose confirmation does not match its own reason", () => {
    expect(() => parseResetIntent(markerWith({ confirmation: FORCED_KEY_CONFIRMATION }).toString("utf8")))
      .toThrow(/reset-intent/);
  });

  it("refuses a marker whose unit id is not a safe path component", () => {
    expect(() => parseResetIntent(markerWith({ unitId: "../escape" }).toString("utf8"))).toThrow(/reset-intent/);
  });

  it("refuses a marker whose timestamp is not an instant", () => {
    expect(() => parseResetIntent(markerWith({ at: "whenever" }).toString("utf8"))).toThrow(/reset-intent/);
  });

  it("refuses a marker whose principal fields are empty or unbounded", () => {
    expect(() => parseResetIntent(markerWith({ actor: { id: "", surface: "cli" } }).toString("utf8"))).toThrow(/reset-intent/);
    expect(() => parseResetIntent(markerWith({ actor: { id: "x".repeat(4096), surface: "cli" } }).toString("utf8"))).toThrow(/reset-intent/);
  });

  it("accepts the marker the builder produces for each reason", () => {
    expect(parseResetIntent(markerWith({}).toString("utf8")).reason).toBe("missing-key");
    const forced = markerWith({ reason: "unreadable-key-forced", confirmation: FORCED_KEY_CONFIRMATION });
    expect(parseResetIntent(forced.toString("utf8")).reason).toBe("unreadable-key-forced");
  });
});

describe("continuation inherits the reset-intent grammar", () => {
  const root = useTempRoot();

  it("refuses a legitimate token whose marker's confirmation was retargeted", async () => {
    // codex round-18 blocker: supersession checked the confirmation/reason pairing but
    // the parser did not, so the continuation path — the one that actually destroys
    // state — accepted a marker an audited sibling reader would have refused.
    const { unitId, continuation } = await recordFirstPassIntent(root.dir, AT);
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    const stored = JSON.parse((await readFile(paths.resetIntentFile)).toString("utf8")) as Record<string, unknown>;
    await writeFile(paths.resetIntentFile, canonicalBytes({ ...stored, confirmation: FORCED_KEY_CONFIRMATION }));

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
      continuation,
    })).rejects.toThrow();
  });
});
