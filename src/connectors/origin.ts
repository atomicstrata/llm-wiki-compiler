/**
 * @file src/connectors/origin.ts
 * @description The single connector-origin predicate shared by every review surface.
 *
 * Connector origin decides whether the approval pin is required and whether a
 * body is displayed fenced, so `review show` and `review approve` must agree on
 * it byte-for-byte. Both surfaces import this module instead of carrying their
 * own copies: a signal added here reaches the pin and the fence together.
 */
import { parseFrontmatter } from "../utils/markdown.js";
import { readConnectorBlock } from "./fence.js";
import type { DurableConnectorBlock } from "./types.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Read the durable connector block from a candidate body without trusting sidecar metadata. */
export function connectorBlockFromBody(body: string): DurableConnectorBlock | null {
  try {
    return readConnectorBlock(parseFrontmatter(body).meta);
  } catch {
    return null;
  }
}

/** Connector-origin is security relevant, so derive it from every durable signal. */
export function isConnectorCandidate(candidate: ReviewCandidate): boolean {
  return (
    candidate.reviewMode === "connector" ||
    candidate.connectorProvenance !== undefined ||
    candidate.heldReasons.some((reason) => reason.code === "connector-fetched") ||
    connectorBlockFromBody(candidate.body) !== null
  );
}
