/**
 * @file src/local-workflows/human-input-schema.ts
 * @description Runtime admission for the closed declarative human-input
 * grammar. It validates bounded scalar and list values, resolves every entity
 * and artifact reference against active authority, and enforces optional
 * run-input subsets without evaluating callbacks or accepting nested objects.
 */

import { Buffer } from "node:buffer";
import { parseArtifactRef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { parseEntityId } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { EntityId, HumanInputDescriptorV1, HumanInputFieldV1, ProfilePack } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowObservations } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

type InputObservations = Pick<LocalWorkflowObservations, "artifact" | "entityFrontmatter">;

/** A caller's human input does not satisfy its active stage descriptor. */
export class HumanInputValidationError extends Error {
  constructor(readonly field: string, detail: string) {
    super(`invalid human input '${field}': ${detail}`);
    this.name = "HumanInputValidationError";
  }
}

/** Convert a declared run-input subset to its exact string members. */
function allowedValues(run: WorkflowRun, field: HumanInputFieldV1): Set<string> | undefined {
  if (!("allowedInput" in field) || field.allowedInput === undefined) return undefined;
  const raw = run.inputs[field.allowedInput];
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) return new Set(raw);
  throw new HumanInputValidationError(field.allowedInput, "bound run input is not a string or string list");
}

/** Require a value to belong to its optional bound run-input subset. */
function assertAllowed(value: string, allowed: Set<string> | undefined, name: string): void {
  if (allowed !== undefined && !allowed.has(value)) {
    throw new HumanInputValidationError(name, "reference is outside the bound run-input subset");
  }
}

/** Validate and resolve one entity reference. */
function parseEntity(value: unknown, name: string): { compact: string; parsed: ReturnType<typeof parseEntityId> } {
  if (typeof value !== "string") throw new HumanInputValidationError(name, "must be an entity reference");
  try { return { compact: value, parsed: parseEntityId(value as EntityId) }; }
  catch { throw new HumanInputValidationError(name, "must be a valid entity reference"); }
}

/** Require the live entity to satisfy an optional lifecycle allowlist. */
function assertEntityState(
  field: HumanInputFieldV1, meta: Record<string, unknown>, lifecycleField: string | undefined, name: string,
): void {
  const states = "lifecycleStates" in field ? field.lifecycleStates : undefined;
  if (states === undefined) return;
  if (lifecycleField === undefined || !states.includes(String(meta[lifecycleField]))) {
    throw new HumanInputValidationError(name, "entity lifecycle state is not allowed");
  }
}

/** Validate and resolve one entity reference. */
async function admitEntity(
  root: string, profile: ProfilePack, value: unknown, field: HumanInputFieldV1, run: WorkflowRun, name: string,
  observations: InputObservations,
): Promise<string> {
  const { compact, parsed } = parseEntity(value, name);
  const types = "entityTypes" in field ? field.entityTypes ?? [] : [];
  if (!types.includes(parsed.entityType)) throw new HumanInputValidationError(name, "entity type is not allowed");
  assertAllowed(compact, allowedValues(run, field), name);
  const def = profile.entities[parsed.entityType];
  const read = await observations.entityFrontmatter(root, def, parsed.slug);
  if (read.kind !== "frontmatter") throw new HumanInputValidationError(name, "entity is absent or unreadable");
  assertEntityState(field, read.meta, def.lifecycle?.field, name);
  return compact;
}

/** Validate and resolve one hash-pinned artifact reference. */
async function admitArtifact(
  root: string, profile: ProfilePack, value: unknown, field: HumanInputFieldV1, run: WorkflowRun, name: string,
  observations: InputObservations,
): Promise<string> {
  const ref = parseArtifactRef(value);
  if (ref === null) throw new HumanInputValidationError(name, "must be a hash-pinned artifact reference");
  const types = "artifactTypes" in field ? field.artifactTypes ?? [] : [];
  if (!types.includes(ref.artifactType)) throw new HumanInputValidationError(name, "artifact type is not allowed");
  assertAllowed(value as string, allowedValues(run, field), name);
  if ((await observations.artifact(root, profile, ref)).health !== "ok") {
    throw new HumanInputValidationError(name, "artifact is not healthy");
  }
  return value as string;
}

/** Validate one bounded string field. */
function admitString(value: unknown, field: Extract<HumanInputFieldV1, { kind: "string" }>, name: string): unknown {
  if (value === null && field.nullable === true) return null;
  if (typeof value !== "string" || Buffer.byteLength(value) > field.maxBytes) {
    throw new HumanInputValidationError(name, "must satisfy its UTF-8 byte bound");
  }
  return value;
}

/** Validate one bounded string-list field. */
function admitStringList(
  value: unknown, field: Extract<HumanInputFieldV1, { kind: "string-list" }>, name: string,
): string[] {
  if (!Array.isArray(value) || value.length > field.maxItems
    || !value.every((item) => typeof item === "string" && Buffer.byteLength(item) <= field.maxItemBytes)) {
    throw new HumanInputValidationError(name, "must be a bounded string list");
  }
  return value;
}

/** Validate every member of a bounded reference list. */
async function admitRefList(
  root: string, profile: ProfilePack, run: WorkflowRun,
  field: Extract<HumanInputFieldV1, { kind: "ref-list" }>, value: unknown, name: string,
  observations: InputObservations,
): Promise<string[]> {
  if (!Array.isArray(value) || value.length > field.maxItems) throw new HumanInputValidationError(name, "must be a bounded reference list");
  const admitted: string[] = [];
  for (const member of value) {
    admitted.push(field.referenceKind === "entity"
      ? await admitEntity(root, profile, member, field, run, name, observations)
      : await admitArtifact(root, profile, member, field, run, name, observations));
  }
  return admitted;
}

/** Validate one declared field, including every member of a reference list. */
async function admitField(
  root: string, profile: ProfilePack, run: WorkflowRun, field: HumanInputFieldV1, value: unknown, name: string,
  observations: InputObservations,
): Promise<unknown> {
  if (field.kind === "string") return admitString(value, field, name);
  if (field.kind === "enum") {
    if (typeof value !== "string" || !field.values.includes(value)) throw new HumanInputValidationError(name, "is outside its enum");
    return value;
  }
  if (field.kind === "string-list") return admitStringList(value, field, name);
  if (field.kind === "entity-ref") return admitEntity(root, profile, value, field, run, name, observations);
  if (field.kind === "artifact-ref") return admitArtifact(root, profile, value, field, run, name, observations);
  return admitRefList(root, profile, run, field, value, name, observations);
}

/** Admit a complete captured payload and apply declared defaults. */
export async function admitHumanInput(
  root: string, profile: ProfilePack, run: WorkflowRun, descriptor: HumanInputDescriptorV1, input: Record<string, unknown>,
  observations: InputObservations,
): Promise<Record<string, unknown>> {
  const declared = new Set(Object.keys(descriptor.fields));
  for (const key of Object.keys(input)) {
    if (!declared.has(key)) throw new HumanInputValidationError(key, "field is not declared");
  }
  const admitted: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(descriptor.fields)) {
    const value = Object.hasOwn(input, name) ? input[name] : field.default;
    if (value === undefined) {
      if (field.required === true) throw new HumanInputValidationError(name, "required field is missing");
      continue;
    }
    admitted[name] = await admitField(root, profile, run, field, value, name, observations);
  }
  return admitted;
}
