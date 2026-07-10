/**
 * @file test/connectors/origin.test.ts
 * @description One shared connector-origin predicate backs every review surface.
 */
import { describe, expect, it } from "vitest";
import { connectorBlockFromBody, isConnectorCandidate } from "../../src/connectors/origin.js";
import type { ReviewCandidate } from "../../src/utils/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const BLOCK_BODY = [
  "---",
  "title: Paper",
  "x-llmwiki.connector:",
  "  connectorId: crossref",
  '  connectorVersion: "1"',
  "  sourceUrl: https://api.crossref.org/works/10.123/example",
  '  fetchedAt: "2026-07-06T00:00:00.000Z"',
  `  contentHash: ${HASH_A}`,
  `  idempotencyKey: ${HASH_B}`,
  "  externalFields:",
  "    - title",
  "---",
  "Connector body",
].join("\n");

/** A plain non-connector candidate; individual tests flip one signal at a time. */
function baseCandidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    id: "paper-0000",
    title: "Paper",
    slug: "paper",
    summary: "",
    sources: [],
    body: "---\ntitle: Paper\n---\nPlain body",
    generatedAt: "2026-07-08T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "forced" }],
    ...overrides,
  };
}

describe("isConnectorCandidate", () => {
  it("is false for a candidate with no connector signal", () => {
    expect(isConnectorCandidate(baseCandidate())).toBe(false);
  });

  it("recognizes reviewMode connector", () => {
    expect(isConnectorCandidate(baseCandidate({ reviewMode: "connector" }))).toBe(true);
  });

  it("recognizes sidecar connectorProvenance", () => {
    const provenance = {
      connectorId: "crossref",
      connectorVersion: "1",
      sourceUrl: "https://api.crossref.org/works/10.123/example",
      fetchedAt: "2026-07-06T00:00:00.000Z",
      contentHash: HASH_A,
      draftContentHash: HASH_B,
      idempotencyKey: HASH_B,
    };
    expect(isConnectorCandidate(baseCandidate({ connectorProvenance: provenance }))).toBe(true);
  });

  it("recognizes the connector-fetched held reason", () => {
    expect(isConnectorCandidate(baseCandidate({ heldReasons: [{ code: "connector-fetched" }] }))).toBe(true);
  });

  it("recognizes the durable in-body block when all sidecar metadata is stripped", () => {
    expect(isConnectorCandidate(baseCandidate({ body: BLOCK_BODY }))).toBe(true);
  });
});

describe("connectorBlockFromBody", () => {
  it("returns the durable block parsed from body frontmatter", () => {
    expect(connectorBlockFromBody(BLOCK_BODY)).toMatchObject({
      connectorId: "crossref",
      contentHash: HASH_A,
      idempotencyKey: HASH_B,
    });
  });

  it("returns null for a body without the block or with unparseable frontmatter", () => {
    expect(connectorBlockFromBody("---\ntitle: Plain\n---\nBody")).toBeNull();
    expect(connectorBlockFromBody("---\n[broken yaml\n---\nBody")).toBeNull();
  });
});
