/**
 * @file src/commands/preparation/host.ts
 * @description The CLI host's half of the preparation service contract: the
 * principal every local invocation acts under, and the resolver the service is
 * constructed with.
 *
 * NOT AN AUTHORITY BOUNDARY, and this file previously claimed to be one. It was
 * called a "plan-authority resolver" and returned an "admission digest"; an
 * external review established that it fingerprints a plan and authorizes
 * nothing:
 *
 *  - it admitted every plan whose project had a readable profile and key;
 *  - nothing compared a plan's named knowledge / operations / action / safety
 *    authorities against any host policy, because no registry exists;
 *  - the digest reached CLI output and nothing else — no durable record, no
 *    later consumer;
 *  - and for a first staging it was computed with an absent-key marker, then
 *    staging minted the key, so it could not even be recomputed unchanged.
 *
 * Adding a real boundary means a host policy source that does not exist, which
 * is more machinery than this slice should invent. So the claim is withdrawn
 * rather than dressed up: **the CLI surface is local-operator-only**, and the
 * readiness precheck it re-exports is an honest statement that the project is in
 * a state the operator can act in — nothing more. When a host authority
 * genuinely exists, it belongs in its own change with its own durable binding.
 */

import { createPreparationService } from "../../preparations/service.js";
import type {
  PreparationGrant, PreparationPrincipal, PreparationPrincipalResolverV1,
  PreparationServiceV1,
} from "../../preparations/service.js";

// The readiness precheck itself now lives in the service, because `stage` and
// `fail` both take it and a second surface must take the same one. It is
// re-exported here so the CLI path to it is unchanged.
export { resolveHostReadiness } from "../../preparations/service.js";

// The local operator identity is shared with the operation and product command
// groups, so it lives in the neutral `cli/shared` module rather than here.
import { CLI_OPERATOR_ID } from "../../cli/shared.js";

/**
 * The local CLI operator principal.
 *
 * HONEST LIMIT: `effectivePreparationGrants` unions the whole local-operator
 * set into any `cli` principal — transport IS the authority for a local shell
 * invocation — so a grant check against this principal cannot fail, and passing
 * fewer grants here changes nothing. That is a statement about the CLI, not
 * about the check: on the `sdk` surface a principal holds exactly its explicit
 * grants and the same check refuses.
 */
function cliOperatorPrincipal(
  grants: readonly PreparationGrant[] = [],
): PreparationPrincipal {
  return { id: CLI_OPERATOR_ID, surface: "cli", grants };
}

/**
 * The resolver the CLI constructs its service with.
 *
 * The principal comes from HERE, never from a command's arguments: an operator
 * types a plan path and a run id, and there is no flag through which an actor,
 * a surface or a grant can be presented.
 *
 * EXPORTED for the sibling `product` host, which builds the product service on
 * this same resolver. The product service delegates every authority decision to
 * the preparation service it is constructed with, so a second CLI resolver
 * beside this one would be a second answer to a question that has one.
 *
 * @param grants - What the calling verb costs, declared explicitly. Per the
 *   limit above this cannot make a `cli` check fail; it records the intent, and
 *   the same list on the `sdk` surface IS the boundary.
 */
export function cliPrincipalResolver(
  grants: readonly PreparationGrant[] = [],
): PreparationPrincipalResolverV1 {
  return { principalFor: () => cliOperatorPrincipal(grants) };
}

/**
 * The preparation service as the CLI constructs it.
 *
 * ONE PLACE STAMPS `surface: "cli"`. Every command goes through here, so the
 * transport claim is made once by the host rather than once per command — and a
 * command has no way to make it at all.
 *
 * @param root - The project root this invocation acts within.
 * @returns The service bound to the local operator on the `cli` surface.
 */
export function cliPreparationService(root: string): PreparationServiceV1 {
  return createPreparationService({
    root, surface: "cli", principals: cliPrincipalResolver(),
  });
}
