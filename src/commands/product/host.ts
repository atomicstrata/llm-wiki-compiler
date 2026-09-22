/**
 * @file src/commands/product/host.ts
 * @description The CLI host's half of the product service contract: the identity
 * every local product invocation acts under, and the service the `product`
 * command group is built from.
 *
 * IT INVENTS NO AUTHORITY, and there is a specific way it could have. The
 * product service charges exactly what the preparation service charges, because
 * it IS constructed with the host's preparation authority — so this file hands
 * it the SAME resolver `src/commands/preparation/host.ts` already builds rather
 * than a second one that could drift from it. `preview` is built with no grants
 * and `invoke` with `preparation.run`, which is what those two verbs cost.
 *
 * HONEST LIMIT, inherited verbatim from that host: `effectivePreparationGrants`
 * unions the whole local-operator set into any `cli` principal, because a local
 * shell invocation IS the local project operator. So the list passed here cannot
 * make a CLI grant check fail, and it is a DECLARATION of what the verb costs
 * rather than the boundary that enforces it. The identical list on the `sdk`
 * surface is the boundary.
 *
 * THE THREE PROPOSING VERBS TAKE THE GENERIC RUNTIME'S ADAPTERS, not the CLI
 * operation runtime's. A product invocation drives a preparation to a Milestone
 * A HANDOFF; it never approves or applies the bundle it produces, so it needs
 * the seven store adapters and none of the operation authority.
 * `createCliOperationRuntime` would hand it the production authority resolver
 * for a decision `invoke` does not make.
 *
 * `apply` IS THAT DECISION, and so it is the one verb here built on the CLI
 * operation runtime. The split is the point: the power to APPROVE enters this
 * file exactly once, in {@link cliProductApplyDependencies}, and `invoke` cannot
 * reach it. It is also a different VOCABULARY of authority — the operation grant
 * `operation-bundle.approve`, not a preparation grant — because proposing a
 * change and authorizing it are different powers over the same bundle.
 */

import type { OperationGrant } from "../../operation-bundles/principal.js";
import {
  createCliOperationRuntime, createOperationRuntime,
} from "../../operation-bundles/runtime-factory.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PackProviderInvocationV1 } from "../../operations-packs/runtime/runner-input.js";
import type { AttemptClockV1 } from "../../preparations/attempts/types.js";
import type { PreparationGrant } from "../../preparations/principals.js";
import type { ProductApplyDependenciesV1 } from "../../products/apply.js";
import type { PrincipalRefV1 } from "../../products/binding/types.js";
import { createProductService, type ProductServiceV1 } from "../../products/service.js";
import { cliOperatorPrincipal } from "../operation/resolve.js";
import { cliPrincipalResolver } from "../preparation/host.js";
import { CLI_OPERATOR_ID } from "../../cli/shared.js";

/**
 * The audit identity `product activate` records on the binding it writes.
 *
 * AUDIT ONLY. `PrincipalRefV1` carries an id and a surface and deliberately no
 * grants, so a binding can never smuggle authority to act.
 */
export const CLI_ACTIVATION_PRINCIPAL: PrincipalRefV1 = Object.freeze({
  id: CLI_OPERATOR_ID, surface: "cli" as const,
});

/** Wall-clock timestamps for a locally driven run. */
function cliClock(): AttemptClockV1 {
  return { now: () => new Date().toISOString() };
}

/**
 * The product service as the CLI constructs it.
 *
 * ONE PLACE STAMPS `surface: "cli"`, exactly as the preparation host does: the
 * transport claim is made once by the host, and no command has a flag through
 * which to make it at all.
 *
 * @param root - The project root this invocation acts within.
 * @param grants - What the calling verb costs (see the limit in the file
 *   docblock). `preview` passes none; `invoke` passes `preparation.run`.
 * @returns The `preview` and `invoke` operations bound to the local operator.
 */
/**
 * The environment variable naming the operator's provider-invocation module.
 *
 * EXPLICIT OPT-IN, ABSENT BY DEFAULT. llmwiki bundles no provider backend, so
 * without this the CLI runs packs whose phases are all host handlers and a
 * provider phase settles `failed`. Setting it is the operator saying "run
 * providers, using MY module" — a decision only they can make, because the
 * module they name executes on their machine with their privileges.
 *
 * CORE NAMES NO BACKEND. The module is the operator's; nothing here imports a
 * specific one, which is what keeps the platform generic and keeps a product
 * package from choosing what executes.
 */
const PROVIDER_INVOCATION_MODULE_ENV = "LLMWIKI_PROVIDER_INVOCATION_MODULE";

/**
 * Load the operator's provider invocation, if they configured one.
 *
 * @returns The configured invocation, or undefined when none is configured.
 */
export async function cliProviderInvocation(): Promise<PackProviderInvocationV1 | undefined> {
  const configured = process.env[PROVIDER_INVOCATION_MODULE_ENV];
  if (configured === undefined || configured.length === 0) return undefined;
  const loaded = await import(pathToFileURL(path.resolve(configured)).href) as {
    default?: unknown; createProviderInvocation?: unknown;
  };
  const factory = loaded.createProviderInvocation ?? loaded.default;
  if (typeof factory !== "function") {
    throw new Error(`${PROVIDER_INVOCATION_MODULE_ENV} must export createProviderInvocation (or a default export) as a function`);
  }
  const invocation = await (factory as () => Promise<unknown>)();
  // CHECKED, not assumed: a module returning the wrong shape would otherwise
  // surface much later as a provider phase that inexplicably refuses.
  if (typeof (invocation as PackProviderInvocationV1 | undefined)?.legInputFor !== "function") {
    throw new Error(`${PROVIDER_INVOCATION_MODULE_ENV} returned no provider invocation with a legInputFor function`);
  }
  return invocation as PackProviderInvocationV1;
}

export function cliProductService(
  root: string, grants: readonly PreparationGrant[],
  providerInvocation?: PackProviderInvocationV1,
): ProductServiceV1 {
  return createProductService({
    root, surface: "cli", principals: cliPrincipalResolver(grants),
    adapters: createOperationRuntime().adapters, clock: cliClock(),
    // The operator's own, via `cliProviderInvocation`. llmwiki bundles no
    // backend, so a command that constructed one would be choosing to execute
    // third-party code on the operator's behalf without being asked.
    ...(providerInvocation === undefined ? {} : { providerInvocation }),
  });
}

/**
 * What `product apply` costs: the operation grant that approving a bundle costs
 * anywhere else in llmwiki.
 *
 * IT IS THE EXISTING GRANT, NOT A PRODUCT ONE. `llmwiki operation resume` drives
 * a parked bundle under exactly this grant; a bundle a product proposed is not a
 * different kind of bundle, so approving it is not a different kind of authority.
 * A `product.apply` grant would be a second name for one power, and two names
 * for one power is how they come to be granted apart.
 */
const APPLY_GRANTS: readonly OperationGrant[] = ["operation-bundle.approve"];

/**
 * The dependencies a local `product apply` acts under.
 *
 * PRINCIPAL, NOT TRANSPORT (§14.2), the same position the `operation` group
 * records: a local shell caller already holds shell and filesystem access and
 * can take the project lock, so a `cli` principal carrying the operator grant is
 * the sanctioned local authority rather than fabricated elevation. The principal
 * is built by the `operation` group's own constructor so the id and the stamped
 * surface cannot drift between the two groups that approve bundles.
 *
 * THE RUNTIME IS THE CLI-AUTHORIZED ONE, which is what actually makes an apply
 * possible: it installs the production operations-authority resolver, so the
 * executor recomputes the approval snapshot from current state, parks on genuine
 * drift, and fails closed when backing state is unreadable.
 *
 * @param root - The project root this apply acts within.
 * @returns The root, operator principal, and production runtime for one apply.
 */
export function cliProductApplyDependencies(root: string): ProductApplyDependenciesV1 {
  return {
    root,
    principal: cliOperatorPrincipal(APPLY_GRANTS),
    runtime: createCliOperationRuntime(),
  };
}
