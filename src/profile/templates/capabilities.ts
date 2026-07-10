/**
 * @file src/profile/templates/capabilities.ts
 * @description Derives user-facing template capabilities from validated
 * ProfilePack data. This keeps the manifest from becoming a second, drift-prone
 * authority about what a template can do.
 */
import type { EntityTypeDef, ProfilePack } from "../types.js";
import type { DerivedTemplateCapabilities } from "./types.js";

/** Whether any entity lifecycle declares relation-count preconditions. */
function hasRelationPreconditions(profile: ProfilePack): boolean {
  return Object.values(profile.entities).some((def) => hasRequirements(def, "transitionRelationRequirements"));
}

/** Whether any entity lifecycle declares artifact-existence preconditions. */
function hasArtifactPreconditions(profile: ProfilePack): boolean {
  return Object.values(profile.entities).some((def) => hasRequirements(def, "transitionArtifactRequirements"));
}

/** Whether any entity declares progressive content tiers. */
function hasContentTiers(profile: ProfilePack): boolean {
  return Object.values(profile.entities).some((def) => (def.contentTiers ?? []).length > 0);
}

/** Count all non-empty requirement arrays for one lifecycle property. */
function hasRequirements(def: EntityTypeDef, key: "transitionRelationRequirements" | "transitionArtifactRequirements"): boolean {
  return Object.values(def.lifecycle?.[key] ?? {}).some((reqs) => reqs.length > 0);
}

/** Derive the installable template's feature summary from its profile pack. */
export function deriveTemplateCapabilities(profile: ProfilePack): DerivedTemplateCapabilities {
  return {
    entities: Object.keys(profile.entities).length,
    relations: Object.keys(profile.relations ?? {}).length,
    workflows: Object.keys(profile.workflows ?? {}).length,
    workflowActions: Object.keys(profile.workflowActions ?? {}).length,
    artifacts: Object.keys(profile.artifacts ?? {}).length,
    connectors: Object.keys(profile.connectors ?? {}).sort(),
    contentTiers: hasContentTiers(profile),
    relationPreconditions: hasRelationPreconditions(profile),
    artifactPreconditions: hasArtifactPreconditions(profile),
  };
}
