/**
 * @file src/operations-packs/composition-refs.ts
 * @description Cross-object reference validation for one composed single-root
 * pack (design section 11.3 rule 9). Every action execution reference, provider
 * role reference, and alias action target must resolve inside the pack. A
 * configuration action resolves into a configuration-flow authority this slice
 * defers, so it is refused here as unresolved rather than silently accepted.
 * Readiness-rule references are already refused at parse (see parse-action).
 */

import { PackDeferredError, PackParseError } from "./problems.js";
import type {
  AliasDescriptorV1, InvocationSurfaceV1, PackActionV2, WorkspaceOperationsPackV2,
} from "./types.js";

/** Resolve one action's execution reference (preparation recipe / deferred flow). */
function assertExecutionRef(action: PackActionV2, pack: WorkspaceOperationsPackV2, label: string): void {
  if (action.execution.kind === "configuration") {
    throw new PackDeferredError(`configuration action ${label} (configuration-flow authority)`);
  }
  if (!Object.hasOwn(pack.recipes, action.execution.recipeRef)) {
    throw new PackParseError(`${label} recipeRef ${action.execution.recipeRef} is unresolved`);
  }
}

/** Every provider-role input field must name a declared provider requirement. */
function assertInputRoleRefs(action: PackActionV2, roleIds: ReadonlySet<string>, label: string): void {
  for (const [name, field] of Object.entries(action.inputSchema)) {
    if (field.kind === "provider-role" && !roleIds.has(field.roleId)) {
      throw new PackParseError(`${label} input ${name} references unknown provider role ${field.roleId}`);
    }
  }
}

/** Validate every action's execution and provider-role references. */
function assertActionCrossRefs(pack: WorkspaceOperationsPackV2, roleIds: ReadonlySet<string>): void {
  for (const [id, action] of Object.entries(pack.actions)) {
    assertExecutionRef(action, pack, `actions.${id}`);
    assertInputRoleRefs(action, roleIds, `actions.${id}`);
  }
}

/** Every recipe provider-phase role must name a declared provider requirement. */
function assertPhaseRoleRefs(pack: WorkspaceOperationsPackV2, roleIds: ReadonlySet<string>): void {
  for (const [recipeId, recipe] of Object.entries(pack.recipes)) {
    for (const phase of recipe.phases) {
      if (phase.kind === "provider" && !roleIds.has(phase.body.providerRoleId)) {
        throw new PackParseError(
          `recipes.${recipeId} phase ${phase.phaseId} references unknown provider role ${phase.body.providerRoleId}`);
      }
    }
  }
}

/** Every workspace-contract required capability role must be a declared provider requirement. */
function assertContractRoleRefs(pack: WorkspaceOperationsPackV2, roleIds: ReadonlySet<string>): void {
  for (const role of pack.workspaceContract.requiredProviderCapabilityRoles) {
    if (!roleIds.has(role)) {
      throw new PackParseError(`workspaceContract requiredProviderCapabilityRoles references unknown provider role ${role}`);
    }
  }
}

/**
 * Every readiness dimension a provider requirement REQUIRES must be declared by
 * the workspace contract.
 *
 * Without this, a provider requirement can name a capability the readiness
 * review will never mention — the review enumerates the workspace's declared
 * dimensions, so a required one that is missing from that list simply does not
 * appear, and an operator reads a clean report while a required capability is
 * unaccounted for. Refusing at composition makes the omission a packaging
 * error instead of a silent hole in the report.
 */
function assertRequiredReadinessRefs(pack: WorkspaceOperationsPackV2): void {
  const declared = new Set(
    pack.workspaceContract.productReadinessDimensions.map((dimension) => dimension.dimensionId),
  );
  for (const requirement of pack.providerRequirements) {
    for (const dimension of requirement.requiredReadinessDimensions) {
      if (!declared.has(dimension)) {
        throw new PackParseError(
          `providerRequirements ${requirement.roleId} requires readiness dimension ${dimension}`
          + " which workspaceContract.productReadinessDimensions does not declare",
        );
      }
    }
  }
}

/** Every recipe render-phase templateRef must name a declared render template. */
function assertRenderTemplateRefs(pack: WorkspaceOperationsPackV2): void {
  const declared = pack.renderTemplates ?? {};
  for (const [recipeId, recipe] of Object.entries(pack.recipes)) {
    for (const phase of recipe.phases) {
      if (phase.kind === "render" && !Object.hasOwn(declared, phase.body.templateRef)) {
        throw new PackParseError(
          `recipes.${recipeId} phase ${phase.phaseId} references unknown render template ${phase.body.templateRef}`);
      }
    }
  }
}

/**
 * An alias may only reach a transport the canonical action exposes with a
 * non-disabled cap (section 19.1). For an agent alias the transport is its
 * declared transportSurface; otherwise it is the alias surface itself.
 */
function assertAliasSurfaceCap(alias: AliasDescriptorV1, action: PackActionV2, label: string): void {
  const transport: InvocationSurfaceV1 | undefined = alias.surface === "agent" ? alias.transportSurface : alias.surface;
  if (transport === undefined) throw new PackParseError(`${label} agent alias has no transport surface`);
  const cap = action.requestedSurfaceCaps[transport];
  if (cap === undefined || cap === "disabled") {
    throw new PackParseError(`${label} targets surface ${transport} the action does not expose`);
  }
}

/** Every alias must resolve to a declared action reachable on its transport. */
function assertAliasCrossRefs(pack: WorkspaceOperationsPackV2): void {
  for (const alias of pack.aliases ?? []) {
    if (!Object.hasOwn(pack.actions, alias.actionId)) {
      throw new PackParseError(`alias ${alias.aliasId} targets unknown action ${alias.actionId}`);
    }
    assertAliasSurfaceCap(alias, pack.actions[alias.actionId]!, `alias ${alias.aliasId}`);
  }
}

/** Validate all cross-object references after single-root namespacing (11.3.9). */
export function assertCrossReferences(pack: WorkspaceOperationsPackV2): void {
  const roleIds = new Set(pack.providerRequirements.map((requirement) => requirement.roleId));
  assertActionCrossRefs(pack, roleIds);
  assertPhaseRoleRefs(pack, roleIds);
  assertContractRoleRefs(pack, roleIds);
  assertRequiredReadinessRefs(pack);
  assertRenderTemplateRefs(pack);
  assertAliasCrossRefs(pack);
}
