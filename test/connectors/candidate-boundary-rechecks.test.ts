/**
 * @file test/connectors/candidate-boundary-rechecks.test.ts
 * @description The connector candidate ceiling is independently rechecked at
 * staging and durable event boundaries, before either boundary mutates state.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateCustodyReceipt } from "../../src/compiler/candidate-custody.js";
import { ConnectorCandidateBatchOverflowError } from "../../src/connectors/candidate-batch.js";
import { appendConnectorEvent } from "../../src/connectors/audit.js";
import { stageConnectorCandidate } from "../../src/connectors/stage-candidate.js";
import { readEvents } from "../../src/events/store-read.js";
import { RESEARCH_LITE_PROFILE } from "../fixtures/profile-fixtures.js";
import { validateProfile } from "../../src/profile/validate.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Build one inert receipt used only to exercise the pre-effect count floor. */
function fixtureReceipt(index: number): CandidateCustodyReceipt {
  return {
    fileId: `candidate-${index}`,
    byteCount: 1,
    sha256: "a".repeat(64),
    fileIdentity: { dev: 1, ino: index + 1 },
    storeIdentity: { dev: 1, ino: 1 },
  };
}

/** Minimal event draft with fixed host-owned fields. */
function auditDraft() {
  return {
    provenance: { connectorId: "fixture", connectorVersion: "1" },
    finalUrl: "https://fixture.local/story-1",
    contentHash: "a".repeat(64),
    draftContentHash: "b".repeat(64),
    idempotencyKey: "c".repeat(64),
  };
}

describe("connector candidate boundary rechecks", () => {
  it("refuses 201 archive receipts before replacement staging", async () => {
    const receipts = Array.from({ length: 201 }, (_, index) => fixtureReceipt(index));

    await expect(stageConnectorCandidate(root.dir, {
      entityType: "papers",
      slug: "replacement",
      body: "---\ntitle: Replacement\n---\nBody\n",
      provenance: {
        connectorId: "fixture", connectorVersion: "1", sourceUrl: "https://fixture.local",
        fetchedAt: "2026-01-01T00:00:00.000Z", contentHash: "a".repeat(64),
        draftContentHash: "b".repeat(64), idempotencyKey: "c".repeat(64),
      },
    }, validateProfile(RESEARCH_LITE_PROFILE).profile, receipts)).rejects
      .toBeInstanceOf(ConnectorCandidateBatchOverflowError);

    expect(existsSync(path.join(root.dir, ".llmwiki", "candidates"))).toBe(false);
  });

  it("refuses a 201-id audit event before append", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `candidate-${index}`);

    await expect(appendConnectorEvent(root.dir, auditDraft(), [], [], ids))
      .rejects.toBeInstanceOf(ConnectorCandidateBatchOverflowError);

    expect((await readEvents(root.dir)).events).toEqual([]);
  });
});
