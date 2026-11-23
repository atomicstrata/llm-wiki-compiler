/**
 * @file src/portable/scoped-disk/disk-scope.ts
 * @description The canonical form of a declared disk compile scope, and the
 * checks it must pass before anything is read or generated.
 *
 * As on the authority-only path, canonicalization is total — a malformed
 * request is a recorded refusal of its operation id, never an untyped error —
 * and admission refuses a malformed name, an empty or oversized source list,
 * or a bound above the DISK ceilings. A request for lexical context is refused
 * by name: a directory has no bounded context index in this slice, and no
 * prompt is ever given an empty corpus in its place.
 */

import { PortableRefusal } from "../errors.js";
import { isScopedSourceName } from "../scoped/namespaces.js";
import { boundsAdmitted, digestibleOf, scopeParts } from "../scoped/scope.js";
import { DISK_SCOPED_CEILINGS, type DiskCompileScopeV2 } from "./disk-contracts.js";

/** A disk scope as received: canonical when it has the declared shape, otherwise only what can be digested. */
export type ReceivedDiskScope =
  | { scope: DiskCompileScopeV2; digestInput: DiskCompileScopeV2; asksContext: boolean }
  | { scope: null; digestInput: unknown; asksContext: boolean };

/**
 * Canonicalize a received disk scope. Total: it never throws. A scope with the
 * declared closed shape comes back with its source names sorted and
 * de-duplicated; anything else comes back as `scope: null`. A context request
 * is reported, never carried over, so it can be refused by name.
 */
export function receivedDiskScope(input: unknown): ReceivedDiskScope {
  const { value, sources, namespace, names, bounds } = scopeParts(input);
  const asksContext = value.context !== undefined && value.context !== null;
  const isDeclaredShape = sources.kind === "source-names" && namespace.kind === "root-concepts" && names !== null && bounds !== null;
  if (!isDeclaredShape || asksContext) return { scope: null, digestInput: digestibleOf(input), asksContext };
  const scope: DiskCompileScopeV2 = {
    sources: { kind: "source-names", names: [...new Set(names)].sort() },
    namespace: { kind: "root-concepts" }, context: null, bounds,
  };
  return { scope, digestInput: scope, asksContext };
}

/**
 * Refuse a disk scope the host does not admit.
 *
 * @throws PortableRefusal `capability_unsupported` for a context request,
 *   `operation_unsupported_on_portable_path` for a malformed scope,
 *   `limit_exceeded` for one over the declared or disk bounds.
 */
export function admittedDiskScope(received: ReceivedDiskScope): DiskCompileScopeV2 {
  if (received.asksContext) throw new PortableRefusal("capability_unsupported", "lexical context is not offered on a registered directory");
  const { scope } = received;
  const names = scope?.sources.names ?? [];
  if (scope === null || names.length === 0 || !names.every(isScopedSourceName)) {
    throw new PortableRefusal("operation_unsupported_on_portable_path", "malformed scope");
  }
  if (!boundsAdmitted(scope.bounds, DISK_SCOPED_CEILINGS)) throw new PortableRefusal("limit_exceeded", "scope bounds");
  if (names.length > scope.bounds.maxSources) throw new PortableRefusal("limit_exceeded", "named sources");
  return scope;
}
