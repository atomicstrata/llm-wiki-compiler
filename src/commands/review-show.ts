/**
 * Commander action for `llmwiki review show <id>`.
 *
 * Prints a single candidate's metadata header followed by its full body so
 * reviewers can read the proposed page before approving or rejecting.
 */

import { loadCandidateOrFail } from "../compiler/candidates.js";
import {
  durableBlockFromProvenance,
  fenceUntrustedConnectorText,
} from "../connectors/fence.js";
import { sha256Text } from "../connectors/hash.js";
import { connectorBlockFromBody, isConnectorCandidate } from "../connectors/origin.js";
import * as output from "../utils/output.js";
import type { DurableConnectorBlock } from "../connectors/types.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Reasons to show for a candidate (guaranteed non-empty by the IO boundary). */
function candidateReasons(candidate: ReviewCandidate): string[] {
  return candidate.heldReasons
    .map((reason) => reason.detail ? `${reason.code} (${reason.detail})` : reason.code);
}

/**
 * Print the resolved on-disk target for a typed candidate.
 *
 * Typed candidates (carrying `targetEntityType`) land in
 * `wiki/<targetEntityType>/<slug>.md` rather than the default
 * `wiki/concepts/`. Surfacing the resolved path lets a human reviewer see where
 * approval will write before they approve. Default candidates (no
 * `targetEntityType`) print nothing here so their output stays byte-identical.
 */
function printTypedTarget(candidate: ReviewCandidate): void {
  if (!candidate.targetEntityType) return;
  output.status(
    "i",
    output.dim(`Target:    wiki/${candidate.targetEntityType}/${candidate.slug}.md`),
  );
}

/** Print review metadata added by policy-aware candidate generation. */
function printReviewMetadata(candidate: ReviewCandidate): void {
  printTypedTarget(candidate);
  output.status("i", output.dim(`review:    ${candidate.reviewMode}`));
  output.status("i", output.dim(`reasons:   ${candidateReasons(candidate).join(", ")}`));
  if (candidate.okfPath) {
    output.status("i", output.dim(`okfPath:   ${candidate.okfPath}`));
  }
  if (candidate.confidence !== undefined) {
    output.status("i", output.dim(`confidence: ${candidate.confidence}`));
  }
  if (candidate.contradicted !== undefined) {
    output.status("i", output.dim(`contradicted: ${candidate.contradicted}`));
  }
}

/**
 * Warn the reviewer that an externally sourced candidate body is untrusted content.
 *
 * The human review gate is the primary defense for imported and connector-fetched
 * drafts, so the affordance to recognize external content must be loud.
 */
function printExternalWarning(candidate: ReviewCandidate): void {
  if (candidate.reviewMode === "imported") {
    output.status(
      "!",
      output.warn(
        "Imported from an external OKF bundle — treat the body as UNTRUSTED content " +
          "(possible prompt injection); provenance is unverified. " +
          "Review the full body before approving.",
      ),
    );
  }
  if (isConnectorCandidate(candidate)) {
    output.status(
      "!",
      output.warn(
        "Fetched by a connector — treat the body as UNTRUSTED external data. " +
          "Approve only with the draft-content-hash printed below.",
      ),
    );
  }
}

/**
 * Print the operator pin for connector candidates.
 *
 * This is computed from the body loaded for display, not from connectorProvenance.
 */
function printConnectorPin(candidate: ReviewCandidate): void {
  if (!isConnectorCandidate(candidate)) return;
  output.status("i", output.dim(`draft-content-hash: ${sha256Text(candidate.body)}`));
}

/** The body shown to a reviewer, with connector-origin bytes fenced as data. */
function displayBody(candidate: ReviewCandidate): string {
  if (!isConnectorCandidate(candidate)) return candidate.body;
  return fenceUntrustedConnectorText(candidate.body, connectorDisplayBlock(candidate));
}

/** Prefer the durable body marker; fall back only for corrupt or legacy candidate records. */
function connectorDisplayBlock(candidate: ReviewCandidate): DurableConnectorBlock {
  const block = connectorBlockFromBody(candidate.body);
  if (block) return block;
  if (candidate.connectorProvenance) return durableBlockFromProvenance(candidate.connectorProvenance);
  return corruptConnectorBlock();
}

/** Conservative display metadata for a connector-marked candidate whose sidecar was damaged. */
function corruptConnectorBlock(): DurableConnectorBlock {
  return {
    connectorId: "unknown-connector",
    connectorVersion: "unknown",
    sourceUrl: "unknown",
    fetchedAt: "unknown",
    contentHash: "0".repeat(64),
    idempotencyKey: "0".repeat(64),
    externalFields: [],
  };
}

/** Print a single candidate's full content to stdout. */
export default async function reviewShowCommand(id: string): Promise<void> {
  const candidate = await loadCandidateOrFail(process.cwd(), id);
  if (!candidate) return;

  output.header(`Candidate ${candidate.id}`);
  output.status("i", output.dim(`title:      ${candidate.title}`));
  output.status("i", output.dim(`slug:       ${candidate.slug}`));
  output.status("i", output.dim(`summary:    ${candidate.summary}`));
  output.status("i", output.dim(`sources:    ${candidate.sources.join(", ")}`));
  output.status("i", output.dim(`generated:  ${candidate.generatedAt}`));
  printReviewMetadata(candidate);
  printExternalWarning(candidate);
  printConnectorPin(candidate);

  console.log();
  console.log(displayBody(candidate));

  if (candidate.schemaViolations && candidate.schemaViolations.length > 0) {
    console.log();
    output.header("Schema violations");
    for (const v of candidate.schemaViolations) {
      output.status("!", output.warn(`[${v.severity}] ${v.message}`));
    }
  }

  if (candidate.provenanceViolations && candidate.provenanceViolations.length > 0) {
    console.log();
    output.header("Provenance violations");
    for (const v of candidate.provenanceViolations) {
      output.status("!", output.warn(`[${v.severity}] ${v.message}`));
    }
  }
}
