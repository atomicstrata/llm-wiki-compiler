/**
 * @file test/products/product-vertical-package.ts
 * @description The vertical product's package: its operations pack (plain,
 * gated, or targeting an undeclared entity type), its knowledge profile, and the
 * complete `ProductPackageManifestV1` built around them.
 *
 * Kept apart from `product-vertical-fixture.ts`, which installs, activates and
 * drives the package in-process. Building the package needs only the pack and
 * signing helpers, so the CLI suites that hand the package to a subprocess do
 * not load the product service and operation runtime. Bun loads each test
 * file's import graph afresh.
 */

import { recomputeCompositionLock } from "../../src/operations-packs/composition-lock.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { singleIntentRecipe, singleIntentRecipeWithGate } from "../operations-packs/compile-fixture.js";
import { buildPack } from "../operations-packs/pack-fixture.js";
import { buildProductPackage, type BuiltProductPackage } from "./product-package-fixture.js";

/** The canonical action id the vertical drives. */
export const VERTICAL_ACTION_ID = "demo.run";

/** The alias token that reaches {@link VERTICAL_ACTION_ID} on the SDK surface. */
export const VERTICAL_ALIAS_TOKEN = "draft";

/** The workspace every vertical run is recorded under. */
export const VERTICAL_WORKSPACE_ID = "research";

/** The recipe id the shared pack fixture declares. */
const RECIPE_ID = "demo.prepare";

/** The entity type the vertical's recipe targets AND its profile declares. */
const VERTICAL_ENTITY_TYPE = "wiki-page";

/** The `wiki/<entityType>` directory the page-create adapter actually writes. */
const VERTICAL_ENTITY_DIRECTORY = `wiki/${VERTICAL_ENTITY_TYPE}`;

/**
 * A valid, non-default knowledge profile the resolver can load. By default it
 * declares the action's target entity type UNDER the `wiki/<entityType>` directory
 * the page-create adapter writes, so the create the obligation authors lands in
 * its own declared namespace — the property the product resolver now checks. A
 * refusal suite overrides `directory` to prove a mismatch is refused.
 */
function verticalProfile(directory: string = VERTICAL_ENTITY_DIRECTORY): Record<string, unknown> {
  return {
    schemaVersion: 1, profileId: "custom", displayName: "Vertical Product",
    entities: { [VERTICAL_ENTITY_TYPE]: { directory } },
  };
}

/**
 * The vertical's operations pack: one action over the single-intent recipe, and
 * one alias reaching it on the SDK surface.
 *
 * @param mutate - Optional last mutation, so a refusal suite can perturb exactly
 *   one property while every other stays well-formed.
 */
export function verticalPack(mutate?: (pack: WorkspaceOperationsPackV2) => void): WorkspaceOperationsPackV2 {
  const pack = buildPack();
  pack.recipes = { [RECIPE_ID]: singleIntentRecipe() };
  pack.actions = {
    [VERTICAL_ACTION_ID]: {
      ...pack.actions[VERTICAL_ACTION_ID]!,
      inputSchema: {
        topic: { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 256 },
      },
    },
  };
  pack.aliases = [
    { aliasId: "draft-alias", surface: "sdk", token: VERTICAL_ALIAS_TOKEN, actionId: VERTICAL_ACTION_ID },
  ];
  mutate?.(pack);
  return pack;
}

/**
 * The SAME vertical product whose recipe declares a required review gate.
 *
 * Only the recipe differs, so a suite comparing it against {@link verticalPack}
 * isolates the gate: a refusal here beside a resolution there is evidence the
 * guard reads the gate rather than refusing everything.
 */
export function gatedVerticalPack(): WorkspaceOperationsPackV2 {
  return verticalPack((pack) => { pack.recipes = { [RECIPE_ID]: singleIntentRecipeWithGate() }; });
}

/** A slug-safe entity type the vertical profile deliberately does NOT declare. */
const UNDECLARED_ENTITY_TYPE = "unregistered-page";

/**
 * The SAME vertical product whose intent phase targets an entity type the active
 * profile never declares. Only the target profile class differs from
 * {@link verticalPack}, so a refusal here beside a resolution there isolates the
 * profile-entity check the resolver applies before any run stages.
 */
export function undeclaredTargetVerticalPack(): WorkspaceOperationsPackV2 {
  return verticalPack((pack) => {
    const intent = pack.recipes[RECIPE_ID]!.phases.find((phase) => phase.kind === "intent");
    if (intent?.kind !== "intent") throw new Error("vertical recipe has no intent phase");
    intent.body = {
      ...intent.body,
      intents: intent.body.intents.map((group, index) =>
        index === 0 ? { ...group, targetProfileClass: UNDECLARED_ENTITY_TYPE } : group),
    };
  });
}

/** Build the complete product package around one operations pack and profile. */
export function buildVerticalProduct(
  pack: WorkspaceOperationsPackV2 = verticalPack(),
  profile: Record<string, unknown> = verticalProfile(),
): BuiltProductPackage {
  return buildProductPackage({
    knowledgeProfileBody: canonicalBytes(profile).toString("utf8"),
    operationsPackBody: canonicalBytes(pack).toString("utf8"),
    compositionLockBody: canonicalBytes(recomputeCompositionLock(pack)).toString("utf8"),
  });
}

/**
 * The vertical product whose wiki-page entity IS declared, but under a directory
 * other than the `wiki/<entityType>` namespace the page-create adapter writes.
 * The entity resolves, yet its create would land outside its own declared
 * directory — so the resolver refuses it before any run stages.
 */
export function misplacedEntityProduct(): BuiltProductPackage {
  return buildVerticalProduct(verticalPack(), verticalProfile("wiki/pages"));
}
