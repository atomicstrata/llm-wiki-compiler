/**
 * @file test/preparations/run-fixture.ts
 * @description In-memory preparation-run construction helpers for the integrity,
 * state-machine, and headroom suites. A test key signs a genesis content and any
 * appended transitions; the signed record can be serialized, tampered, and fed
 * back through the exact-shape loader to prove a detection or a rejection.
 */

import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  appendPreparationTransition, createInitialPreparationRun, preparationKeyEpochId,
  preparationRunBinding, signPreparationRun,
} from "../../src/preparations/run-integrity.js";
import type {
  AppendPreparationTransitionInput, PreparationRunBinding, PreparationRunContentV1,
} from "../../src/preparations/run-types.js";

const RUN_ID = `prr_${"1".repeat(32)}` as const;
const PREPARATION_ID = `prp_${"2".repeat(32)}` as const;
const MANIFEST_DIGEST = parseSha256Digest(`sha256:${"3".repeat(64)}`);

/** The fixed 32-byte test key used to sign in-memory run records. */
export function testKey(): Buffer {
  return Buffer.alloc(32, 0xa5);
}

/** Build one genesis `planned` run content bound to the fixed test identities. */
export function genesisContent(): PreparationRunContentV1 {
  return createInitialPreparationRun({
    runId: RUN_ID, preparationId: PREPARATION_ID, manifestDigest: MANIFEST_DIGEST,
    workspaceId: "research", keyEpochId: preparationKeyEpochId(testKey()),
    actor: { id: "operator", surface: "cli" }, at: "2026-07-20T00:00:00.000Z",
    controlTransitionAllowance: 16,
  });
}

/** Append one transition to a run content through the pure constructor. */
export function append(content: PreparationRunContentV1, input: AppendPreparationTransitionInput): PreparationRunContentV1 {
  return appendPreparationTransition(content, input);
}

/** The exact external binding for the fixture run. */
export function fixtureBinding(): PreparationRunBinding {
  return preparationRunBinding(genesisContent());
}

/** Sign and serialize one run content into its canonical durable text. */
export function signedRunText(content: PreparationRunContentV1, key: Buffer = testKey()): string {
  return canonicalBytes(signPreparationRun(key, content)).toString("utf8");
}
