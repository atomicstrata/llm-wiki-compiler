/**
 * @file src/operations-packs/parse-action.ts
 * @description Parser for one PackActionV2 (design section 14.1) to its full spec
 * shape: the execution union (preparation or configuration), the closed input
 * schema, per-surface requested capability caps, the confirmation policy, and the
 * optional gate/compatibility lists. A declared action-to-setting binding and a
 * non-empty readinessRuleRefs are refused as deferred authorities (settings,
 * readinessRules) rather than under-parsed, and an unknown invocation surface or
 * capability class fails closed.
 */

import { booleanValue, enumValue, exact, record, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { MAX_ACTION_INPUT_FIELDS, MAX_CLOSED_STRING_SET } from "./constants.js";
import { assertActionId, assertMessageKey, assertRefId, assertSlug, assertPackVersion } from "./ids.js";
import { PackDeferredError, PackParseError } from "./problems.js";
import { parseInputField } from "./parse-input-field.js";
import type {
  CapabilityClass, ConfirmationPolicyV1, InvocationSurfaceV1, PackActionExecutionV2, PackActionV2,
} from "./types.js";
import { parseObjectMap, slugList } from "./values.js";

const INVOCATION_SURFACES = ["cli", "sdk", "mcp", "viewer"] as const;
const CAPABILITY_CLASSES = ["disabled", "read-only", "staged-write", "trusted-write"] as const;
const EXECUTION_MODES = ["ephemeral-read", "durable-preparation"] as const;
const SEVERITY_FLOORS = ["host-required", "always-confirm"] as const;
const ACTION_REQUIRED = [
  "actionId", "actionVersion", "labelKey", "summaryKey",
  "execution", "inputSchema", "requestedSurfaceCaps", "confirmationPolicy",
] as const;
const ACTION_OPTIONAL = ["requiredGates", "readinessRuleRefs", "settingBindings", "compatibilityTags"] as const;

/** Parse the preparation-or-configuration execution union (section 14.1). */
function parseExecution(value: unknown, label: string): PackActionExecutionV2 {
  const node = record(value, label);
  const kind = enumValue(node.kind, ["preparation", "configuration"], `${label} kind`);
  if (kind === "preparation") {
    exact(node, ["kind", "executionMode", "recipeRef", "outputContractRef"]);
    return {
      kind,
      executionMode: enumValue(node.executionMode, EXECUTION_MODES, `${label} executionMode`),
      recipeRef: assertRefId(node.recipeRef),
      outputContractRef: assertRefId(node.outputContractRef),
    };
  }
  exact(node, ["kind", "flowRef"]);
  return { kind, flowRef: assertRefId(node.flowRef) };
}

/** Parse the requested per-surface capability caps; missing surface means disabled. */
function parseSurfaceCaps(value: unknown, label: string): Partial<Record<InvocationSurfaceV1, CapabilityClass>> {
  const node = record(value, label);
  const caps: Partial<Record<InvocationSurfaceV1, CapabilityClass>> = {};
  for (const [key, raw] of Object.entries(node)) {
    const surface = enumValue(key, INVOCATION_SURFACES, `${label} surface`);
    caps[surface] = enumValue(raw, CAPABILITY_CLASSES, `${label}.${key}`);
  }
  return caps;
}

/** Parse the confirmation policy; it can only meet or raise the host floor (section 21). */
function parseConfirmationPolicy(value: unknown, label: string): ConfirmationPolicyV1 {
  const node = record(value, label);
  exact(node, ["severityFloor", "requestPostResultConfirmation"]);
  return {
    severityFloor: enumValue(node.severityFloor, SEVERITY_FLOORS, `${label} severityFloor`),
    requestPostResultConfirmation: booleanValue(node.requestPostResultConfirmation, `${label}.requestPostResultConfirmation`),
  };
}

/** Parse the required identity, execution, schema, caps, and confirmation fields. */
function parseActionCore(node: JsonRecord, label: string): Omit<PackActionV2, "requiredGates" | "readinessRuleRefs" | "settingBindings" | "compatibilityTags"> {
  return {
    actionId: assertActionId(node.actionId),
    actionVersion: assertPackVersion(node.actionVersion),
    labelKey: assertMessageKey(node.labelKey),
    summaryKey: assertMessageKey(node.summaryKey),
    execution: parseExecution(node.execution, `${label}.execution`),
    inputSchema: parseObjectMap(node.inputSchema, `${label}.inputSchema`, MAX_ACTION_INPUT_FIELDS, assertSlug, parseInputField),
    requestedSurfaceCaps: parseSurfaceCaps(node.requestedSurfaceCaps, `${label}.requestedSurfaceCaps`),
    confirmationPolicy: parseConfirmationPolicy(node.confirmationPolicy, `${label}.confirmationPolicy`),
  };
}

/** Parse the optional gate and compatibility-tag reference lists. */
function parseActionOptional(node: JsonRecord, label: string): Pick<PackActionV2, "requiredGates" | "compatibilityTags"> {
  const optional: Pick<PackActionV2, "requiredGates" | "compatibilityTags"> = {};
  if (node.requiredGates !== undefined) optional.requiredGates = slugList(node.requiredGates, `${label}.requiredGates`, MAX_CLOSED_STRING_SET);
  if (node.compatibilityTags !== undefined) optional.compatibilityTags = slugList(node.compatibilityTags, `${label}.compatibilityTags`, MAX_CLOSED_STRING_SET);
  return optional;
}

/**
 * Readiness-rule refs resolve into the deferred readinessRules authority, so a
 * non-empty list is refused at parse — consistent with every other deferral —
 * rather than parsed and only later rejected during composition.
 */
function refuseReadinessRefs(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new PackParseError(`${label}.readinessRuleRefs must be an array`);
  if (value.length > 0) throw new PackDeferredError("action readiness rule refs (readinessRules authority)");
}

/** Parse and structurally validate one product action (section 14.1). */
export function parseAction(value: unknown, label: string): PackActionV2 {
  const node = record(value, label);
  exact(node, ACTION_REQUIRED, ACTION_OPTIONAL);
  if (node.settingBindings !== undefined) throw new PackDeferredError("action setting bindings (settings authority)");
  refuseReadinessRefs(node.readinessRuleRefs, label);
  return { ...parseActionCore(node, label), ...parseActionOptional(node, label) };
}
