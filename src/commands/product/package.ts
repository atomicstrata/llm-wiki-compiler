/**
 * @file src/commands/product/package.ts
 * @description `llmwiki product install <sourceDir>` and
 * `llmwiki product activate <packageDigest>` — the two verbs that put a product
 * package in a project and make it that project's authority.
 *
 * THEY ARE ADAPTERS. The copy into owner-private staging, every digest and graph
 * verification, the project lock, the recovery gate, the atomic rename and the
 * readback all live in `src/products`; what is here is the operator's own
 * vocabulary: one path argument, one digest argument, and how an outcome prints.
 *
 * THE TWO ARE SEPARATE VERBS BECAUSE THE SUBSTRATE SEPARATES THEM. Installing
 * writes inert bytes and NEVER writes `active-product.json`; a package sitting
 * in the store governs nothing until an operator activates it by exact digest.
 * Collapsing them into one verb would make an install that failed its receipt
 * indistinguishable from an activation, which is precisely the state the
 * installer is built to keep apart — so `install` ends by naming the activate
 * command instead of performing it.
 *
 * THE DIGEST IS VALIDATED HERE, at the boundary, through the production grammar.
 * `activateProductLocked` takes a branded digest, so the string an operator
 * typed has to pass `assertProductDigest` before it can name a stored package —
 * and a typo is then a typed refusal rather than a cast that reaches a path join.
 */

import { withQuietJson } from "../../cli/shared.js";
import { activateProductLocked, type ActivateResultV1 } from "../../products/binding/activate.js";
import { assertProductDigest } from "../../products/ids.js";
import {
  installLocalProductPackage, type ProductInstallResultV1,
} from "../../products/packages/install.js";
import { CLI_ACTIVATION_PRINCIPAL } from "./host.js";
import {
  emitProduct, refusalPresentation, settleProduct,
  type ProductPresentationV1, type ProductRefusalV1,
} from "./render.js";

/** Options shared by both package verbs. */
export interface ProductPackageOptions {
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/** What one settled install prints. */
function installPresentation(
  outcome: ProductInstallResultV1 | ProductRefusalV1,
): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  const verb = outcome.status === "installed" ? "installed" : "already present";
  return {
    lines: [
      `${verb}: ${outcome.productId} ${outcome.productVersion}`,
      `package digest: ${outcome.packageDigest}`,
      provenanceLine(outcome),
      // NOTHING IS ACTIVE YET, and saying so is the point: the installer writes
      // inert bytes only. An operator told "installed" and nothing else would
      // reasonably expect the product to be governing the project.
      `no product was activated — run: llmwiki product activate ${outcome.packageDigest}`,
    ],
    code: 0, refused: false,
  };
}

/**
 * The provenance line, which reports the receipt honestly.
 *
 * A local install is `local-unverified` — the bytes were verified against their
 * own digests, and NOTHING attested to where they came from. A receipt that
 * could not be written leaves even that record absent, which the installer
 * treats as inert bytes with provenance unavailable rather than as a failure.
 */
function provenanceLine(outcome: ProductInstallResultV1): string {
  return outcome.receiptWritten
    ? `provenance: ${outcome.provenance} (local bytes; nothing attested to their origin)`
    : `provenance: ${outcome.provenance}, but the install receipt could not be written — this package's provenance is unavailable`;
}

/** What one settled activation prints. */
function activatePresentation(
  outcome: ActivateResultV1 | ProductRefusalV1,
): ProductPresentationV1 {
  if (outcome.status === "refused") return refusalPresentation(outcome.reason);
  return {
    lines: [
      `activated: ${outcome.productId} ${outcome.productVersion}`,
      `package digest: ${outcome.packageDigest}`,
      "this product is now the project's knowledge and operations authority",
    ],
    code: 0, refused: false,
  };
}

/**
 * `llmwiki product install <sourceDir>`. Returns the process exit code.
 *
 * @param root - The project root to install into.
 * @param sourceDir - The operator-supplied package directory.
 * @param options - `--json`.
 */
export async function productInstallCommand(
  root: string, sourceDir: string, options: ProductPackageOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WHOLE VERB in `--json` mode, as `preparation stage` does:
  // the install takes the project lock, whose helper prints "Another
  // compilation is running." on stdout — ahead of the envelope, breaking every
  // `JSON.parse` consumer on the one path an operator hits under contention.
  return withQuietJson(json, async () => {
    const outcome = await settleProduct(() => installLocalProductPackage(root, sourceDir));
    return emitProduct(outcome, json, installPresentation(outcome));
  });
}

/**
 * `llmwiki product activate <packageDigest>`. Returns the process exit code.
 *
 * @param root - The project root whose authority is being set.
 * @param packageDigest - The exact `sha256:`-prefixed digest to activate.
 * @param options - `--json`.
 */
export async function productActivateCommand(
  root: string, packageDigest: string, options: ProductPackageOptions = {},
): Promise<number> {
  const json = options.json === true;
  return withQuietJson(json, async () => {
    const outcome = await settleProduct(async () =>
      activateProductLocked(root, assertProductDigest(packageDigest), CLI_ACTIVATION_PRINCIPAL));
    return emitProduct(outcome, json, activatePresentation(outcome));
  });
}
