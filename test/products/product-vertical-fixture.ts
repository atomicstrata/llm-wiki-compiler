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
 *
 * The package itself is built in `product-vertical-package.ts`, which needs no
 * installer, activator or service: the CLI suites that only write the package
 * for a subprocess import that module and skip loading this one's runtime.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import type { PreparationGrant } from "../../src/preparations/principals.js";
import { activateProductLocked } from "../../src/products/binding/activate.js";
import { installLocalProductPackage } from "../../src/products/packages/install.js";
import type { AttemptClockV1 } from "../../src/preparations/attempts/types.js";
import { createProductService, type ProductServiceV1 } from "../../src/products/service.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import { writeSourcePackage, type BuiltProductPackage } from "./product-package-fixture.js";
import { buildVerticalProduct } from "./product-vertical-package.js";

/** The activating operator recorded on the binding. */
const OPERATOR = { id: "operator-1", surface: "cli" } as const;

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
