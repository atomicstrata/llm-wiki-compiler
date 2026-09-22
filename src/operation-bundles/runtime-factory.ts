/**
 * @file src/operation-bundles/runtime-factory.ts
 * @description The single production assembly of an {@link OperationRuntime}.
 *
 * The executor and recovery coordinator consume a core-injected runtime carrying
 * the seven authoritative store adapters, an authority provider, and a clock.
 * Until this module, that runtime existed only in the test fixtures (each test
 * assembled the adapter set inline). This factory is the one shared production
 * construction so every operator entry point (the `operation` CLI group, and any
 * future SDK/MCP surface) drives the identical adapter set rather than duplicating
 * the seven-slot literal.
 *
 * Authority is a STRUCTURAL split, not a comment-enforced one:
 *   - {@link createOperationRuntime} is the generic builder and is FAIL-CLOSED by
 *     default — with no explicit `authority` it installs {@link refusingAuthorityProvider}
 *     and can approve/apply/recover nothing. A caller that legitimately holds a
 *     resolver may inject it; tests inject a domain-neutral one.
 *   - {@link createCliOperationRuntime} is the ONLY convenience constructor that
 *     installs the production operations-authority resolver, and it exists solely
 *     for the local `operation` CLI group, which holds local project-operator
 *     authority (§14.2). It binds the adapter-capability component to the real host
 *     adapter kinds rather than trusting the request copy.
 *
 * Keeping the resolver OUT of the generic default means a future SDK/MCP surface
 * cannot gain operation authority merely by importing the generic factory and
 * presenting an approve-granted principal — SDK/MCP authority stays gated by its
 * own host-configured principal grants (§14.2). A boundary test statically pins
 * that SDK/MCP never import the CLI-authorized constructor or the resolver module.
 */

import {
  createOperationAdapterRegistry,
  OPERATION_MUTATION_KINDS,
  type OperationAdapterSet,
  type OperationRuntime,
} from "./adapter-registry.js";
import { refusingAuthorityProvider, type OperationAuthorityProvider } from "./authority.js";
import { createOperationsAuthorityResolver } from "./operations-authority-resolver.js";
import { sourceAdapter } from "./adapters/source.js";
import { pageAdapter } from "./adapters/page.js";
import { relationAdapter } from "./adapters/relation.js";
import { lifecycleAdapter } from "./adapters/lifecycle.js";
import { artifactAdapter } from "./adapters/artifact.js";
import { catalogAdapter } from "./adapters/catalog.js";
import { projectionAdapter } from "./adapters/projection.js";
import type { Clock } from "./stage.js";

/** The seven real authoritative store adapters, one per closed mutation kind. */
function defaultOperationAdapterSet(): OperationAdapterSet {
  return {
    "source-retain": sourceAdapter,
    page: pageAdapter,
    relation: relationAdapter,
    "lifecycle-transition": lifecycleAdapter,
    artifact: artifactAdapter,
    "catalog-record": catalogAdapter,
    projection: projectionAdapter,
  };
}

/** Optional overrides for a runtime (an injected authority provider or clock). */
export interface OperationRuntimeOptions {
  /** An authority provider to install; omitted, the generic builder fails closed. */
  authority?: OperationAuthorityProvider;
  /** A deterministic clock; omitted, wall-clock time is used. */
  clock?: Clock;
}

/** Assemble a runtime over the seven real adapters with the given authority/clock. */
function assembleRuntime(authority: OperationAuthorityProvider, clock: Clock | undefined): OperationRuntime {
  return {
    authority,
    adapters: createOperationAdapterRegistry(defaultOperationAdapterSet()),
    clock: clock ?? { now: () => new Date() },
  };
}

/**
 * Build the generic operation runtime over the seven real adapters. FAIL-CLOSED by
 * default: with no explicit `authority` it installs {@link refusingAuthorityProvider},
 * so it can approve/apply/recover nothing. Production operation authority is opt-in
 * through {@link createCliOperationRuntime}, never a silent default of this builder.
 *
 * @param options - Optional authority provider / clock overrides.
 * @returns A runtime ready to pass to the executor and recovery seams.
 */
export function createOperationRuntime(options: OperationRuntimeOptions = {}): OperationRuntime {
  return assembleRuntime(options.authority ?? refusingAuthorityProvider, options.clock);
}

/**
 * Build the local-CLI operation runtime: the ONLY convenience constructor that
 * installs the production operations-authority resolver. It exists solely for the
 * `operation` CLI group, whose caller holds local project-operator authority
 * (§14.2). The resolver is bound to the real host adapter kinds so the
 * adapter-capability component is recomputed from source, never the request copy.
 *
 * @param options - Optional authority provider / clock overrides (authority defaults to the resolver).
 * @returns A production runtime for the local operator recovery surface.
 */
export function createCliOperationRuntime(options: OperationRuntimeOptions = {}): OperationRuntime {
  const authority = options.authority
    ?? createOperationsAuthorityResolver({ adapterKinds: [...OPERATION_MUTATION_KINDS] });
  return assembleRuntime(authority, options.clock);
}
