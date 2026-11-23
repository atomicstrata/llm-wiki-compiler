/**
 * @file src/portable/project/runtime.ts
 * @description What one session's operations run with: the host's control
 * state, the project's store, the principal the host derived, and the model the
 * host configured. All of it is server-side; none of it is client-supplied.
 *
 * The model is an explicit seam. A host that was given none holds `null`, and
 * a proposal on it is refused at admission with `capability_unsupported`
 * before any generation runs. Nothing here builds a provider from the process
 * environment, and nothing substitutes a stand-in model.
 *
 * The seam FAILS CLOSED. The configured factory's result is checked before it
 * can answer any model call: a provider whose four required methods are
 * callable, and a non-blank provider name and model id. This matters because
 * the shared provider lookup answers a scope whose override has no provider
 * with the one built from the environment; a malformed result from an untyped
 * caller would otherwise reach that provider, and stamp drafts with an
 * identity nobody configured.
 */

import type { PrincipalContext } from "../contracts.js";
import { PortableHostError } from "../errors.js";
import type { HostControl } from "../host/control.js";
import type { ProjectStore } from "../store/store.js";
import type { ProviderOverride } from "../../utils/provider.js";

/**
 * The model a host runs a proposal's compile under: called once per
 * generation, it returns the provider and the identity stamped into the
 * drafts. Supplied by whoever composes the host, in that host's own process.
 */
export type HostModel = () => ProviderOverride;

/** The host-side context of one project session. */
export interface ProjectRuntime {
  control: HostControl;
  store: ProjectStore;
  principal: PrincipalContext;
  /** The model the host runs the compile under, or `null` when the host was configured with none. */
  model: HostModel | null;
}

/** The provider methods every configured model must answer. `embedBatch` is optional. */
const REQUIRED_PROVIDER_METHODS = ["complete", "stream", "toolCall", "embed"] as const;

/** True for a non-null object that is not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for a string with at least one non-whitespace character. */
function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when `provider` answers every required method, and `embedBatch`, if supplied, is callable too. Methods may be inherited. */
function isCompleteProvider(provider: unknown): boolean {
  if (provider === null || typeof provider !== "object") return false;
  const methods = provider as Record<string, unknown>;
  const hasRequired = REQUIRED_PROVIDER_METHODS.every((name) => typeof methods[name] === "function");
  return hasRequired && (methods.embedBatch === undefined || typeof methods.embedBatch === "function");
}

/**
 * The factory's result, unchanged, once it is a complete override.
 *
 * @throws PortableHostError naming what is malformed; nothing is substituted or normalized.
 */
function checkedOverride(result: unknown): ProviderOverride {
  if (!isPlainObject(result)) throw new PortableHostError("the configured model returned no provider override");
  if (!isCompleteProvider(result.provider)) throw new PortableHostError("the configured model's provider is missing a required method");
  if (!isNonBlank(result.providerName) || !isNonBlank(result.modelId)) {
    throw new PortableHostError("the configured model's provider name and model id must be non-blank");
  }
  return result as unknown as ProviderOverride;
}

/**
 * The configured model of a runtime whose proposal was already admitted: the
 * factory is called exactly once, and its result is returned only when it is a
 * complete override. A factory that throws propagates its error unchanged.
 *
 * @throws PortableHostError when no callable model is configured (admission
 *   refuses `null` first, so reaching this is a host composition bug) or the
 *   factory's result is not a complete override.
 */
export function requireHostModel(runtime: ProjectRuntime): ProviderOverride {
  // `typeof`, not `=== null`: an untyped caller may configure something that is neither null nor callable.
  if (typeof runtime.model !== "function") throw new PortableHostError("no model is configured for this host");
  return checkedOverride(runtime.model());
}
