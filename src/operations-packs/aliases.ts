/**
 * @file src/operations-packs/aliases.ts
 * @description Resolve one invocation token — a canonical action id OR a
 * familiar alias — to the exact (action, surface) pair the plan compiler is
 * called with (design section 19.1).
 *
 * ALIAS IS NOT AUTHORITY (WOP-INV-21). An alias is a NAME, so resolving through
 * one may change nothing about what runs. Two properties enforce that here:
 *
 *  - THE SURFACE IS THE CALLER'S, NEVER THE ALIAS'S. The resolved
 *    `requestedSurface` is the transport the caller actually arrived on, and an
 *    alias is only eligible when its own transport EQUALS that surface. The
 *    surface selects the action's capability-class ceiling, so an alias that
 *    could carry its own would be choosing a ceiling — and the alias and direct
 *    invocations of one action would compile to different plans.
 *  - THE RESOLVER RETURNS AN ACTION ID AND NOTHING ELSE. In particular it does
 *    NOT apply `defaultInputs`: the compiler seals the resolved input into the
 *    plan's initial input set, so injected defaults would change the plan digest
 *    and break the equality this module exists to guarantee. An alias that
 *    declares non-empty defaults is REFUSED rather than silently stripped —
 *    under-applying a declared default is the hollow half of the same defect.
 *
 * THE COMPOSED GRAPH IS THE EXPOSURE AUTHORITY. Eligible ids are read from the
 * composition's flattened export table, not from the pack record, because that
 * table is what composition validated for destination uniqueness and alias
 * invocation distinctness (section 11.3 rule 6). A resolver enumerating the pack
 * directly would be a second index that could disagree with the first.
 *
 * REFUSALS NAME THE CLASS AND THE SURFACE, NEVER THE TOKEN. The token is
 * unbounded untrusted caller input; the closed refusal code already tells a
 * caller what went wrong without echoing bytes it supplied.
 */

import { PackParseError } from "./problems.js";
import type {
  AliasDescriptorV1, ComposedGraphV1, InvocationSurfaceV1, PackActionV2, ResolvedExportV1,
  WorkspaceOperationsPackV2,
} from "./types.js";

/** The capability class that names an explicitly withdrawn surface. */
const DISABLED_CAPABILITY_CLASS = "disabled";

/** Why one invocation token did not resolve to a runnable action. */
export type ActionTokenRefusalCodeV1 =
  | "unknown-token"
  | "ambiguous-token"
  | "surface-not-exposed"
  | "alias-default-inputs-deferred";

/** Whether the caller named the canonical action or one of its aliases. */
export type ActionTokenRouteV1 = "action-id" | "alias";

/** One resolved token: the canonical action and the surface it runs under. */
export interface ResolvedActionTokenV1 {
  readonly status: "resolved";
  readonly actionId: string;
  readonly requestedSurface: InvocationSurfaceV1;
  readonly route: ActionTokenRouteV1;
  /** The alias that carried the token, when the route was an alias. */
  readonly aliasId?: string;
}

/** One refused token, classified so a caller need not read the prose. */
export interface RefusedActionTokenV1 {
  readonly status: "refused";
  readonly code: ActionTokenRefusalCodeV1;
  readonly detail: string;
}

/** The closed outcome of resolving one invocation token. */
export type ActionTokenResolutionV1 = ResolvedActionTokenV1 | RefusedActionTokenV1;

/** One token resolution request: the verified pack, its graph, and the caller. */
export interface ActionTokenRequestV1 {
  readonly pack: WorkspaceOperationsPackV2;
  readonly composed: ComposedGraphV1;
  /** The canonical action id or alias token the caller invoked. */
  readonly token: string;
  /** The transport the caller actually arrived on. */
  readonly surface: InvocationSurfaceV1;
}

/** Build one classified refusal. */
function refuse(code: ActionTokenRefusalCodeV1, detail: string): RefusedActionTokenV1 {
  return { status: "refused", code, detail };
}

/** The exposed ids of one export kind, as composition resolved them. */
function exposedIds(composed: ComposedGraphV1, kind: ResolvedExportV1["kind"]): ReadonlySet<string> {
  return new Set(composed.resolvedExports.filter((row) => row.kind === kind).map((row) => row.exposedId));
}

/**
 * The invocation transport one alias reaches its action through. An `agent`
 * alias declares it explicitly (the parser requires it); every other alias's
 * transport IS its surface.
 */
function aliasTransport(alias: AliasDescriptorV1): InvocationSurfaceV1 | undefined {
  return alias.surface === "agent" ? alias.transportSurface : alias.surface;
}

/** Read one declared action by id without traversing a prototype or accessor. */
function actionOf(pack: WorkspaceOperationsPackV2, actionId: string): PackActionV2 | undefined {
  return new Map(Object.entries(pack.actions)).get(actionId);
}

/**
 * Every EXPOSED alias whose transport is the caller's surface and whose token is
 * the one invoked. Composition guarantees no two aliases share a
 * (surface, host, locale, token) invocation, which does NOT make this list
 * single-valued: a `cli` alias and an `agent` alias whose transport is `cli` are
 * distinct under that key and both reach the caller here. Two answers is an
 * ambiguity the caller must resolve, never a pick this resolver may make.
 */
function matchingAliases(request: ActionTokenRequestV1): readonly AliasDescriptorV1[] {
  const exposed = exposedIds(request.composed, "alias");
  return (request.pack.aliases ?? []).filter((alias) => exposed.has(alias.aliasId)
    && aliasTransport(alias) === request.surface && alias.token === request.token);
}

/**
 * Admit one canonical action on the caller's surface, or refuse it.
 *
 * The surface check mirrors composition's own alias cross-reference rule
 * (`composition-refs.assertAliasSurfaceCap`) and applies to the DIRECT route
 * too: an action that exposes no capability on a transport is not invocable
 * through it, however the caller named it.
 */
function admit(
  request: ActionTokenRequestV1, actionId: string, route: ActionTokenRouteV1, aliasId?: string,
): ActionTokenResolutionV1 {
  if (!exposedIds(request.composed, "action").has(actionId)) {
    return refuse("unknown-token", `the composed graph exposes no action for this ${route}`);
  }
  const action = actionOf(request.pack, actionId);
  if (action === undefined) throw new PackParseError("the composed graph exposes an action the pack does not declare");
  const ceiling = action.requestedSurfaceCaps[request.surface];
  if (ceiling === undefined || ceiling === DISABLED_CAPABILITY_CLASS) {
    return refuse("surface-not-exposed", `the action exposes no capability on the ${request.surface} surface`);
  }
  return {
    status: "resolved", actionId, requestedSurface: request.surface, route,
    ...(aliasId === undefined ? {} : { aliasId }),
  };
}

/** Admit one alias, refusing the declared defaults this slice cannot honour. */
function admitAlias(request: ActionTokenRequestV1, alias: AliasDescriptorV1): ActionTokenResolutionV1 {
  if (Object.keys(alias.defaultInputs ?? {}).length > 0) {
    return refuse(
      "alias-default-inputs-deferred",
      "this alias declares default inputs, which would change the sealed plan an equivalent direct invocation compiles",
    );
  }
  return admit(request, alias.actionId, "alias", alias.aliasId);
}

/**
 * Resolve one invocation token to the canonical action and surface to compile.
 *
 * @param request - The verified pack, its composed graph, the token the caller
 *   invoked, and the transport they arrived on.
 * @returns The canonical action and the caller's own surface, or a classified
 *   refusal. A token that is BOTH a declared action id and an alias on this
 *   surface is ambiguous and refused — an alias may never shadow a direct id.
 */
export function resolveActionToken(request: ActionTokenRequestV1): ActionTokenResolutionV1 {
  const direct = exposedIds(request.composed, "action").has(request.token);
  const aliases = matchingAliases(request);
  if (direct && aliases.length > 0) {
    return refuse("ambiguous-token", `this token is both an action id and an alias on the ${request.surface} surface`);
  }
  if (aliases.length > 1) {
    return refuse("ambiguous-token", `${aliases.length} aliases claim this token on the ${request.surface} surface`);
  }
  const alias = aliases[0];
  if (alias !== undefined) return admitAlias(request, alias);
  if (!direct) return refuse("unknown-token", `no action or alias reaches the ${request.surface} surface under this token`);
  return admit(request, request.token, "action-id");
}
