/**
 * @file test/connectors/final6-fixtures.ts
 * @description Bounded, exact candidate-store fixtures for the Final6
 * connector identity, batch, custody, and terminal-rendering regressions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Text } from "../../src/connectors/hash.js";

export const FIXTURE_CONTENT_HASH = "a".repeat(64);
const FIXTURE_SOURCE_ID = "story-1";
export const FIXTURE_IDEMPOTENCY_KEY = sha256Text(`fixture\n${FIXTURE_SOURCE_ID}`);

/** Options for one exact connector candidate fixture. */
export interface ConnectorCandidateFixture {
  contentHash?: string;
  generatedAt?: string;
  idempotencyKey?: string;
  rawSuffix?: string;
}

/** Build one complete connector candidate with valid sidecar provenance. */
export function connectorCandidateRecord(
  fileId: string,
  fixture: ConnectorCandidateFixture = {},
): Record<string, unknown> {
  return {
    id: fileId,
    title: fileId,
    slug: fileId,
    summary: "",
    sources: [],
    body: `---\ntitle: Fixture\n---\nBody\n${fixture.rawSuffix ?? ""}`,
    generatedAt: fixture.generatedAt ?? "2026-01-01T00:00:00.000Z",
    reviewMode: "connector",
    heldReasons: [{ code: "connector-fetched" }],
    connectorProvenance: {
      connectorId: "fixture",
      connectorVersion: "1",
      sourceUrl: `https://fixture.local/${FIXTURE_SOURCE_ID}`,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      contentHash: fixture.contentHash ?? FIXTURE_CONTENT_HASH,
      draftContentHash: "c".repeat(64),
      idempotencyKey: fixture.idempotencyKey ?? FIXTURE_IDEMPOTENCY_KEY,
    },
  };
}

/** Plant one exactly bound candidate JSON leaf. */
export async function plantConnectorCandidate(
  root: string,
  fileId: string,
  fixture: ConnectorCandidateFixture = {},
): Promise<void> {
  const dir = path.join(root, ".llmwiki", "candidates");
  await mkdir(dir, { recursive: true });
  const record = connectorCandidateRecord(fileId, fixture);
  await writeFile(path.join(dir, `${fileId}.json`), JSON.stringify(record));
}

/** Plant `count` matching candidates with equal timestamps. */
export async function plantConnectorCandidateBatch(root: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `bound-${String(index).padStart(3, "0")}`);
  for (const id of ids) await plantConnectorCandidate(root, id);
  return ids;
}
