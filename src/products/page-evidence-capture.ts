/**
 * @file src/products/page-evidence-capture.ts
 * @description Host-side PAGE-EVIDENCE capture (P5c §2a / amended P5COMMON
 * §8): when an action's provider phase seals a page-evidence descriptor, the
 * host DERIVES the declared values from the page the action targets — a
 * confined frontmatter read, an exact-one relation traversal, a hash-pinned
 * single-body artifact dereference, or an authenticated preparation run —
 * and seals each capture's digest + byte count (and bounded scalar values)
 * under its own `<captureId>-*` key namespace.
 *
 * CALLER INPUT NEVER SUPPLIES A SEALED VALUE. The only caller fields read are
 * the target slug and a run id; a caller supplying ANY derived key is refused
 * outright (the capture owns the namespace), because sealing a caller's copy
 * would turn immutability back into fake authority — the defect this seam
 * exists to close. The runtime sibling re-verifies every sealed source before
 * the provider phase consumes it.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { readConfinedEntityFrontmatter } from "../profile/lifecycle-read.js";
import { declaredProviderPhaseValues } from "./source-evidence-capture.js";
import {
  captureArtifactDeref, capturePageField, captureRelationTarget, captureRunBinding,
} from "./page-evidence-forms.js";
import type { PackActionInputValueV2, WorkspaceOperationsPackV2 } from "../operations-packs/types.js";
import type { PageEvidenceCaptureV2, PageEvidenceDescriptorV2 } from "../operations-packs/recipe-types.js";
import type { LoadedProfile } from "../profile/types.js";

/** One capture outcome: the input with host-owned sealed keys, or a refusal. */
export type PageEvidenceCaptureOutcomeV1 =
  | { readonly input: Readonly<Record<string, PackActionInputValueV2>> }
  | { readonly refused: string };

/** The action's recipe's sole page-evidence descriptor, when one exists. */
function descriptorFor(
  pack: WorkspaceOperationsPackV2, actionId: string,
): PageEvidenceDescriptorV2 | undefined | { readonly refused: string } {
  const declared = declaredProviderPhaseValues<PageEvidenceDescriptorV2>(pack, actionId, "pageEvidenceDescriptor");
  if (declared.length > 1) {
    return { refused: `${declared.length} provider phases declare a pageEvidenceDescriptor; one action may carry at most one` };
  }
  return declared[0];
}

/** Refuse caller input that trespasses on the capture namespace. */
function callerCollision(
  descriptor: PageEvidenceDescriptorV2, input: Readonly<Record<string, PackActionInputValueV2>>,
): string | null {
  // The WHOLE `<captureId>-` prefix is reserved (M5r-code1), not just the
  // keys this version generates — a future derived key must never find a
  // caller already squatting under a supposedly host-derived prefix.
  const prefixes = descriptor.captures.flatMap((capture) => ownedPrefixes(capture));
  const taken = Object.keys(input).find((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  return taken === undefined ? null : `caller input supplies host-owned page-evidence key ${JSON.stringify(taken)}`;
}

/** Every derived-key PREFIX one capture reserves, nested forms included. */
function ownedPrefixes(capture: PageEvidenceCaptureV2): string[] {
  if (capture.form === "relation-target") {
    return [`${capture.captureId}-`, ...capture.then.map((then) => `${then.captureId}-`)];
  }
  if (capture.form === "run-binding") {
    return [`${capture.captureId}-`, ...capture.frozenFields.map((field) => `${field.captureId}-`),
      ...capture.outputs.map((output) => `${output.captureId}-`)];
  }
  return [`${capture.captureId}-`];
}

/** Run one declared capture against the resolved target page. */
async function runCapture(
  root: string, loaded: LoadedProfile, descriptor: PageEvidenceDescriptorV2,
  capture: PageEvidenceCaptureV2, meta: Readonly<Record<string, unknown>>, slug: string,
  input: Readonly<Record<string, PackActionInputValueV2>>,
): Promise<{ seal: Readonly<Record<string, string>> } | { refused: string }> {
  const pageLabel = `${descriptor.target.entityType}/${slug}`;
  if (capture.form === "page-field") {
    const def = loaded.profile.entities[descriptor.target.entityType];
    return capturePageField(meta, capture, pageLabel, def?.fields as Readonly<Record<string, unknown>> | undefined);
  }
  if (capture.form === "artifact-deref") {
    const def = loaded.profile.entities[descriptor.target.entityType];
    return captureArtifactDeref(root, loaded, meta, capture, pageLabel,
      def?.fields as Readonly<Record<string, unknown>> | undefined);
  }
  if (capture.form === "relation-target") return captureRelationTarget(root, loaded, pageLabel, capture);
  const runId = input[capture.runIdFrom];
  if (typeof runId !== "string" || runId.length === 0) {
    return { refused: `capture ${capture.captureId}: the input carries no run id under ${JSON.stringify(capture.runIdFrom)}` };
  }
  return captureRunBinding(root, capture, runId, slug);
}

/**
 * Capture the host-owned page-evidence keys for one action's input, when its
 * recipe's provider phase seals a page-evidence descriptor. An action without
 * one returns the input untouched.
 *
 * @param root - Absolute project root.
 * @param pack - The verified pack the action belongs to.
 * @param actionId - The resolved canonical action id.
 * @param input - The caller's input; only the declared slug and run-id fields
 *   are read, and every `<captureId>-*` key is host-computed.
 */
export async function capturePageEvidenceInput(
  root: string, pack: WorkspaceOperationsPackV2, actionId: string,
  input: Readonly<Record<string, PackActionInputValueV2>>,
): Promise<PageEvidenceCaptureOutcomeV1> {
  const descriptor = descriptorFor(pack, actionId);
  if (descriptor === undefined) return { input };
  if ("refused" in descriptor) return descriptor;
  const collision = callerCollision(descriptor, input);
  if (collision !== null) return { refused: collision };
  const slug = input[descriptor.target.slugField];
  if (typeof slug !== "string" || slug.length === 0) {
    return { refused: `page-evidence input carries no target slug under ${descriptor.target.slugField}` };
  }
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) return { refused: "page evidence requires an active profile" };
  const def = loaded.profile.entities[descriptor.target.entityType];
  if (def === undefined) return { refused: `entity type ${descriptor.target.entityType} is not declared by the active profile` };
  const read = await readConfinedEntityFrontmatter(root, def, slug);
  if (read.kind !== "frontmatter") {
    return { refused: `the targeted page ${descriptor.target.entityType}/${slug} is ${read.kind}` };
  }
  let sealed: Record<string, PackActionInputValueV2> = { ...input };
  for (const capture of descriptor.captures) {
    const outcome = await runCapture(root, loaded, descriptor, capture, read.meta, slug, input);
    if ("refused" in outcome) return outcome;
    sealed = { ...sealed, ...outcome.seal };
  }
  return { input: sealed };
}
