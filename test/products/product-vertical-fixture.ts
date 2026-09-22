/**
 * @file test/products/product-vertical-fixture.ts
 * @description Builds the ONE real product this slice's end-to-end suites drive:
 * a complete `ProductPackageManifestV1` carrying every mandatory member — the
 * knowledge profile, the root operations pack, its exactly-matching composition
 * lock, an interaction resource and the parity ledger — installed through the
 * production installer and activated through the production activator.
 *
 * NOTHING IS REDUCED. The pack is the shared operations-pack fixture with its
 * recipe replaced by the minimal single-intent chain the host-handler runtime
 * can actually execute, and its alias replaced by one this slice's resolver
 * admits (a `sdk`-surface alias declaring no default inputs). Everything else —
 * the contract requirements, the provider requirement, the workspace contract —
 * is the shared fixture's, so the package a test drives is the package the
 * activator would accept from a publisher.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { recomputeCompositionLock } from "../../src/operations-packs/composition-lock.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import type { PreparationGrant } from "../../src/preparations/principals.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { activateProductLocked } from "../../src/products/binding/activate.js";
import { installLocalProductPackage } from "../../src/products/packages/install.js";
import type { AttemptClockV1 } from "../../src/preparations/attempts/types.js";
import { createProductService, type ProductServiceV1 } from "../../src/products/service.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import { singleIntentRecipe, singleIntentRecipeWithGate } from "../operations-packs/compile-fixture.js";
import { buildPack } from "../operations-packs/pack-fixture.js";
import { buildProductPackage, writeSourcePackage, type BuiltProductPackage } from "./product-package-fixture.js";

/** The canonical action id the vertical drives. */
export const VERTICAL_ACTION_ID = "demo.run";

/** The alias token that reaches {@link VERTICAL_ACTION_ID} on the SDK surface. */
export const VERTICAL_ALIAS_TOKEN = "draft";

/** The workspace every vertical run is recorded under. */
export const VERTICAL_WORKSPACE_ID = "research";

/** The recipe id the shared pack fixture declares. */
const RECIPE_ID = "demo.prepare";

/** The activating operator recorded on the binding. */
const OPERATOR = { id: "operator-1", surface: "cli" } as const;

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

/** One project with the vertical product installed and activated. */
export interface ActivatedProjectV1 {
  readonly root: string;
  readonly packageDigest: Sha256Digest;
  cleanup(): Promise<void>;
}

/** Install and activate one built product on a fresh temp project. */
export async function activatedProject(
  product: BuiltProductPackage = buildVerticalProduct(),
): Promise<ActivatedProjectV1> {
  const root = await mkdtemp(path.join(tmpdir(), "product-vertical-"));
  const source = await mkdtemp(path.join(tmpdir(), "product-source-"));
  await writeSourcePackage(source, product);
  const installed = await installLocalProductPackage(root, source);
  if (installed.status !== "installed") throw new Error(`install refused: ${JSON.stringify(installed)}`);
  await activateProductLocked(root, product.manifest.packageDigest, OPERATOR);
  return {
    root, packageDigest: product.manifest.packageDigest,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    },
  };
}

/** The year every timestamp {@link verticalClock} stamps falls in. */
export const VERTICAL_CLOCK_YEAR = "2026";

/** A fresh fixed, monotonic clock, so a driven run's timestamps are deterministic. */
export function verticalClock(): AttemptClockV1 {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++)).toISOString() };
}

/**
 * Build the product service an SDK embedder holding exactly `grants` would get.
 *
 * The adapters are the host's real registered Milestone A set. `clock` is a
 * parameter so a suite can retain the OBJECT it passed and replace its method
 * afterwards — the only way to witness that the service pinned the method it was
 * constructed with rather than reading the caller's object per call.
 */
export function verticalService(
  root: string, grants: readonly PreparationGrant[] = [], clock: AttemptClockV1 = verticalClock(),
): ProductServiceV1 {
  const principal = { id: "sdk-consumer", surface: "sdk" as const, grants: [...grants] };
  return createProductService({
    root, surface: "sdk", principals: { principalFor: () => principal },
    adapters: createOperationRuntime().adapters, clock,
  });
}
