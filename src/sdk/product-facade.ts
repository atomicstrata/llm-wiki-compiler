/**
 * @file src/sdk/product-facade.ts
 * @description The EXPERIMENTAL product slice of the `WikiCore` facade — the SDK
 * surface for invoking an activated product's actions.
 *
 * AN ADAPTER, and nothing else. It imports the product service and the service's
 * types; it reaches no package, binding, pack, plan or preparation module and no
 * filesystem path. Everything a product action IS lives one layer down.
 *
 * AUTHORITY IS THE PREPARATION AUTHORITY, DELIBERATELY. Invoking a product
 * action stages and drives a durable preparation, so it costs exactly the
 * `preparation.run` grant staging costs — charged by the preparation service the
 * product service is built over, not by a second check here. `preview` is
 * grant-free for the same reason its preparation sibling is. The principal is
 * built by {@link sdkPreparationPrincipal} from `createWiki`'s OWN options at
 * CONSTRUCTION, with `surface: "sdk"` stamped, so an embedder that named no
 * grants can preview an action and cannot run one.
 *
 * THE REQUEST IS CONSTRUCTED FIELD BY FIELD. The public input names an `action`
 * — a canonical action id or an alias token — and the service's own request
 * capture refuses anything that is not plain own data, so nothing a caller
 * attaches beyond these three fields reaches the compiler.
 *
 * APPLY IS NOT ON THIS SURFACE, and that is deliberate rather than unfinished.
 * Approving a bundle needs the operation grant `operation-bundle.approve`, and
 * `CreateWikiOptions` carries only PREPARATION grants — there is no
 * host-configured operation-grant surface for an embedder to be given one
 * through — and an operations-authority provider design v2 §14.2 reserves for the
 * local `operation` CLI group. Exposing an `apply` an embedder could never grant
 * would be a method that only ever refuses, and one whose refusal still crosses
 * the shared mutation gate. So applying is a local-operator action today:
 * `llmwiki product apply`. When this surface holds operation authority, `apply`
 * is added over the same `applyProductBundle` seam the CLI already uses.
 *
 * @experimental Foundation API — the shape may change in a future minor release.
 */

import { createOperationRuntime } from "../operation-bundles/runtime-factory.js";
import { createProductService } from "../products/service.js";
import { sdkPreparationPrincipal } from "./preparation-facade.js";
import type { SdkPreparationOptions, SdkProductActionInput, WikiCore } from "./core-types.js";

/** The experimental product method the `WikiCore` facade composes in. */
export type ProductFacadeSlice = Pick<WikiCore, "product">;

/**
 * Build the experimental product slice of the `WikiCore` facade bound to `root`.
 *
 * @param root - Normalized absolute project root.
 * @param runQuiet - The facade's quiet-scoping wrapper (output suppressed).
 * @param options - The embedder's preparation identity and grants, if any.
 * @returns The experimental product WikiCore surface.
 */
export function buildProductFacade(
  root: string,
  runQuiet: <T>(fn: () => Promise<T>) => Promise<T>,
  options?: SdkPreparationOptions,
): ProductFacadeSlice {
  const principal = sdkPreparationPrincipal(options);
  const service = createProductService({
    root,
    // STAMPED, never read from the caller: it is both the invocation surface the
    // action's capability ceiling is selected by and the principal's transport.
    surface: "sdk",
    principals: { principalFor: () => principal },
    // The host's own registered Milestone A store adapters. The default runtime
    // installs no operation authority provider, which is correct here: driving a
    // preparation to handoff STAGES a bundle and approves nothing.
    adapters: createOperationRuntime().adapters,
    clock: { now: () => new Date().toISOString() },
    // The embedder's own provider invocation, when it has one. This is the ONE
    // shipped public surface that can supply it: llmwiki bundles no backend, so
    // without an embedder passing one no provider phase can run at all.
    ...(options?.providerInvocation === undefined
      ? {} : { providerInvocation: options.providerInvocation }),
  });

  /** Copy one caller input into the service request, field by field. */
  function requestFor(input: SdkProductActionInput) {
    return {
      workspaceId: input.workspaceId,
      token: input.action,
      input: input.input ?? {},
      // Carry the optional outer-workflow parent through; `service.resolve`
      // deep-captures the nested ref before any await (P6).
      ...(input.workflowParent === undefined ? {} : { workflowParent: input.workflowParent }),
    };
  }

  return {
    product: {
      preview: (input) => runQuiet(() => service.preview(requestFor(input))),
      invoke: (input) => runQuiet(() => service.invoke(requestFor(input))),
      // OWN-READ, field by field, like the other verbs: `resume` re-drives the
      // run's own sealed input (the service refuses a plan mismatch), so the
      // only caller-aimable inputs are the run id and the token that must
      // reproduce it.
      resume: (input) => runQuiet(() => service.resume({
        workspaceId: input.workspaceId, token: input.action, runId: input.runId,
      })),
    },
  };
}
