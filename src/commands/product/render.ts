/**
 * @file src/commands/product/render.ts
 * @description Shared presentation and refusal classification for the `product`
 * command group.
 *
 * TWO OF THE FOUR VERBS THROW AND TWO RETURN. `installLocalProductPackage` and
 * `activateProductLocked` report a bad package or an unactivatable binding by
 * THROWING a typed problem, while the product service returns a closed
 * `{ status: "refused", reason }` arm. An operator should not be able to tell
 * which, so {@link settleProduct} turns the throwing half into the same closed
 * arm — over a NAMED allowlist of domain classes, never a bare catch. A class
 * not on the list is a statement about this process rather than about the
 * operator's package, and it stays visible as a fault with its stack.
 *
 * THE EXIT CODE IS THE CALLER'S, and that is deliberate. "Refused" is not the
 * only non-zero outcome here: a `preview` whose action compiled but whose dry
 * run declined, and an `invoke` whose run did not reach a handoff, are both real
 * answers that a script must not read as success. Each verb states its own code
 * beside the lines it prints, so the two can never disagree.
 */

import * as output from "../../utils/output.js";
import { emitJson } from "../operation/render.js";
import {
  ActiveProductUnavailableError, ProductActivationError, ProductAuthorityConflictError,
  ProductBindingError,
} from "../../products/binding/problems.js";
import {
  ProductBoundsError, ProductIdentityError, ProductPackageError,
} from "../../products/problems.js";
import type { CompiledActionSummaryV1 } from "../../products/service.js";

/**
 * The domain classes whose throws mean "this package, digest or binding cannot
 * be used", never "this broke partway" — the same fail-closed allowlist
 * discipline `resolveProductAction` applies to compilation.
 */
const PRODUCT_REFUSALS = [
  ProductPackageError, ProductIdentityError, ProductBoundsError,
  ProductBindingError, ProductActivationError,
  ProductAuthorityConflictError, ActiveProductUnavailableError,
] as const;

/** The closed refusal arm every `product` verb answers with. */
export interface ProductRefusalV1 {
  readonly status: "refused";
  readonly reason: string;
}

/** What one settled outcome prints, and the exit code it settles to. */
export interface ProductPresentationV1 {
  readonly lines: readonly string[];
  readonly code: number;
  /** Whether these lines report a refusal, so they print as a warning. */
  readonly refused: boolean;
}

/**
 * Run one throwing product seam and answer in the closed refusal vocabulary.
 *
 * @param work - The install or activation call.
 * @returns Its result, or the typed refusal that stopped it. Any error outside
 *   {@link PRODUCT_REFUSALS} is rethrown and stays visible.
 */
export async function settleProduct<T>(work: () => Promise<T>): Promise<T | ProductRefusalV1> {
  try {
    return await work();
  } catch (error) {
    if (!PRODUCT_REFUSALS.some((problem) => error instanceof problem)) throw error;
    return { status: "refused", reason: (error as Error).message };
  }
}

/** The refusal presentation shared by all four verbs. */
export function refusalPresentation(reason: string): ProductPresentationV1 {
  return { lines: [reason], code: 1, refused: true };
}

/**
 * The two compile-time facts both action verbs report.
 *
 * `planDigest` is here rather than behind `--json` because it is the property a
 * caller can check for themselves: an alias and its canonical action must
 * compile to the same digest, and printing it is what makes that checkable from
 * a shell.
 */
export function compiledActionLines(action: CompiledActionSummaryV1): string[] {
  return [
    `action: ${action.actionId} (reached by ${action.route})`,
    `plan digest: ${action.planDigest}`,
  ];
}

/** How a refused outcome's lines are marked. */
const REFUSAL_STYLE = { icon: "!", paint: output.warn } as const;

/** How a settled outcome's lines are marked. */
const SUCCESS_STYLE = { icon: "✓", paint: output.info } as const;

/** Print one presentation's lines, every line in the outcome's own style. */
function printPresentation(presentation: ProductPresentationV1): void {
  const style = presentation.refused ? REFUSAL_STYLE : SUCCESS_STYLE;
  for (const line of presentation.lines) output.status(style.icon, style.paint(line));
}

/**
 * Emit one settled outcome and return its exit code.
 *
 * In `--json` mode the envelope is the outcome VERBATIM: the service's own
 * status vocabulary reaches a machine consumer unreclassified, and the human
 * lines are suppressed by the caller's quiet scope rather than skipped here.
 *
 * @param outcome - The settled result or refusal, emitted verbatim as JSON.
 * @param json - Whether the operator asked for the machine-readable envelope.
 * @param presentation - The lines and exit code this outcome settles to.
 * @returns The process exit code.
 */
export function emitProduct(
  outcome: unknown, json: boolean, presentation: ProductPresentationV1,
): number {
  if (json) emitJson(outcome);
  else printPresentation(presentation);
  return presentation.code;
}
