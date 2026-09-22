/**
 * @file src/local-workflow-host/observations.ts
 * @description Read-only core observations for workflow evidence and authority.
 * This assembly exposes retained facts; it cannot approve or apply mutations.
 */
import { locatePreparationManifest, readPreparationRunForManifest } from "../preparations/service-run-lookup.js";
import { observeOperationBundle } from "../operation-bundles/observe.js";
import { readLocalWorkflowProcessSource } from "./process-source.js";
import { resolveArtifactRef } from "../artifacts/resolve.js";
import { readLiveTargetDigest } from "./live-target.js";
import { readVerifiedArtifactBody } from "../artifacts/read-verified.js";
import { readConfinedEntityFrontmatter } from "../profile/lifecycle-read.js";
import { readLocalWorkflowEntityDigest } from "./entity-digest.js";
import { readLocalWorkflowArtifactManifest } from "./artifact-manifest.js";

/** Named observations shared by evidence-consuming engine operations. */
export interface LocalWorkflowObservations {
  readonly artifactManifest: typeof readLocalWorkflowArtifactManifest;
  readonly entityFrontmatter: typeof readConfinedEntityFrontmatter;
  readonly entityDigest: typeof readLocalWorkflowEntityDigest;
  readonly processSource: typeof readLocalWorkflowProcessSource;
  readonly artifact: typeof resolveArtifactRef;
  readonly liveTarget: typeof readLiveTargetDigest;
  readonly artifactBody: typeof readVerifiedArtifactBody;
  readonly locatePreparation: typeof locatePreparationManifest;
  readonly readPreparation: typeof readPreparationRunForManifest;
  readonly operationBundle: typeof observeOperationBundle;
}

/** Assemble existing core readers without creating state or granting authority. */
export function createLocalWorkflowObservations(): LocalWorkflowObservations {
  return Object.freeze({ artifactManifest: readLocalWorkflowArtifactManifest,
    entityFrontmatter: readConfinedEntityFrontmatter, entityDigest: readLocalWorkflowEntityDigest,
    locatePreparation: locatePreparationManifest,
    readPreparation: readPreparationRunForManifest, operationBundle: observeOperationBundle,
    processSource: readLocalWorkflowProcessSource, artifact: resolveArtifactRef,
    liveTarget: readLiveTargetDigest, artifactBody: readVerifiedArtifactBody });
}
