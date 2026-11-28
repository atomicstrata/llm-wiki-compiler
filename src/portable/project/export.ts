/**
 * @file src/portable/project/export.ts
 * @description The labelled object stream: the one export form the portable
 * path offers.
 *
 * It covers curated pages and normalized sources only. It does not export
 * graph or event records, authority records or raw originals.
 *
 * An export is a claim that a consumer holds a consistent set, so it is built
 * to be checkable:
 *
 *  - the ordered scope and each object's digest are captured first, in one
 *    consistent view;
 *  - each item is reauthorized against current host state when it is served,
 *    and must still be the bytes that were captured;
 *  - before `completed` is yielded the scope is captured AGAIN and must be
 *    identical. A source added or changed mid-stream ends the stream with
 *    `stopped`, never with a completion it did not earn.
 *
 * A consumer must stage partial output and must not present it as a complete
 * export without the final `completed` item.
 */

import type { ContentDigest } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import { authorize, isVisible } from "../host/policy.js";
import { CONCEPTS_PREFIX, SOURCES_PREFIX } from "../logical-paths.js";
import type { ReadView } from "../store/store.js";
import type { ExportItem } from "./api.js";
import { observeVisible, withProjectRead } from "./reads.js";
import type { ProjectRuntime } from "./runtime.js";

/** One object in the export's scope, as first captured. */
interface ScopeEntry { path: string; digest: ContentDigest }

/** Why a stream ends early. */
type StopReason = Extract<ExportItem, { kind: "stopped" }>["reason"];

/** The ordered pages and sources the principal may export, with their digests, in `view`. */
async function captureScope(runtime: ProjectRuntime, view: ReadView): Promise<ScopeEntry[]> {
  const paths = [...(await view.list(CONCEPTS_PREFIX)), ...(await view.list(SOURCES_PREFIX))]
    .filter((path) => path.endsWith(".md"));
  const scope: ScopeEntry[] = [];
  for (const path of paths) {
    const seen = await observeVisible(runtime, view, path, "export.run");
    if (seen !== null) scope.push({ path, digest: seen.digest });
  }
  return scope;
}

/** Capture the scope, mapping an unresolved publication to a stop reason. */
async function scopeOrStop(runtime: ProjectRuntime): Promise<ScopeEntry[] | StopReason> {
  try {
    return await withProjectRead(runtime, (view) => captureScope(runtime, view));
  } catch (error) {
    if (error instanceof PortableRefusal && error.code === "publication_in_progress") return "publication_in_progress";
    throw error;
  }
}

/** True while the principal may still be served export items, decided now. */
async function mayStillExport(runtime: ProjectRuntime): Promise<boolean> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  return control !== null && isVisible(runtime.control, runtime.principal, "export.run", [control.compartment]);
}

/** Serve one captured object, or the reason the stream must stop at it. */
async function exportOne(runtime: ProjectRuntime, entry: ScopeEntry): Promise<ExportItem> {
  if (!(await mayStillExport(runtime))) return { kind: "stopped", reason: "policy_changed" };
  let seen;
  try {
    seen = await withProjectRead(runtime, (view) => observeVisible(runtime, view, entry.path, "export.run"));
  } catch (error) {
    if (!(error instanceof PortableRefusal) || error.code !== "publication_in_progress") throw error;
    return { kind: "stopped", reason: "publication_in_progress" };
  }
  if (seen === null || seen.digest !== entry.digest) return { kind: "stopped", reason: "drift" };
  return {
    kind: "object", path: entry.path, digest: seen.digest, revision: seen.revision, labels: seen.labels, bytes: seen.bytes,
  };
}

/** True when two captured scopes are the same objects with the same bytes, in order. */
function sameScope(first: readonly ScopeEntry[], second: readonly ScopeEntry[]): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Export curated content as a labelled object stream with an explicit end. */
export async function* exportProject(runtime: ProjectRuntime): AsyncIterable<ExportItem> {
  await authorize(runtime.control, runtime.principal, "export.run");
  const scope = await scopeOrStop(runtime);
  if (typeof scope === "string") { yield { kind: "stopped", reason: scope }; return; }
  if (scope.length > runtime.store.capabilities.limits.maxListPage) {
    yield { kind: "stopped", reason: "limit_exceeded" };
    return;
  }
  for (const entry of scope) {
    const item = await exportOne(runtime, entry);
    yield item;
    if (item.kind === "stopped") return;
  }
  const final = await scopeOrStop(runtime);
  if (typeof final === "string") { yield { kind: "stopped", reason: final }; return; }
  if (!(await mayStillExport(runtime))) { yield { kind: "stopped", reason: "policy_changed" }; return; }
  yield sameScope(scope, final) ? { kind: "completed", count: scope.length } : { kind: "stopped", reason: "drift" };
}
