/**
 * @file src/portable/project/reads.ts
 * @description Portable reads: pages, sources, keyword search and the labelled
 * export stream, all through ONE read-view helper.
 *
 * {@link withProjectRead} is the only way a served read reaches a project. It
 * runs the read against a consistent view — a pinned head on a manifest store,
 * the cooperating gate on disk — and refuses with `publication_in_progress`
 * while a publication intent is unresolved, so a half-applied publication is
 * never served as committed knowledge.
 *
 * Inside a view, bytes, digest, revision and labels are ONE observation: labels
 * are looked up for the exact digest read. Curated bytes written outside the
 * portable path are reconciled to the project compartment under host authority
 * and are never treated as public. Every item is authorized against CURRENT
 * host state, again at the moment it is delivered, and no result varies with
 * whether something was withheld.
 */

import { parseFrontmatter } from "../../utils/markdown.js";
import { searchPages } from "../../viewer/search.js";
import type { ViewerSnapshot } from "../../viewer/types.js";
import { ACCESS_NOTICE, type LabelSet, type ObservedObject, type Permission } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { authorize, isVisible } from "../host/policy.js";
import { CONCEPTS_PREFIX, conceptPagePath, isCuratedPath, sourcePath } from "../logical-paths.js";
import type { ReadView } from "../store/store.js";
import type { LabelledResult, Listed, PageListing, PageView, SearchHit, SourceView } from "./api.js";
import type { ProjectRuntime } from "./runtime.js";

const UTF8 = new TextDecoder("utf-8");

/** One object with the labels bound to exactly the bytes read. */
export interface LabelledObservation extends ObservedObject { labels: LabelSet }

/** Run one served read against a consistent view of the project. */
export function withProjectRead<T>(runtime: ProjectRuntime, fn: (view: ReadView) => Promise<T>): Promise<T> {
  return runtime.store.withReadView(fn);
}

/** Labels for exactly these bytes; curated bytes with no committed record are reconciled. */
async function labelsForObservation(
  runtime: ProjectRuntime, view: ReadView, path: string, seen: ObservedObject,
): Promise<LabelSet | null> {
  const committed = await view.labelsFor(path, seen.digest);
  if (committed !== null || !isCuratedPath(path)) return committed;
  const control = await runtime.control.loadProject(runtime.principal.project);
  if (control === null) return null;
  // Sound only because the single project compartment is also the most restrictive one. A store that
  // retains a stricter binding of this path (an adopted directory) keeps it: a rewrite never lowers it.
  const retained = (await runtime.store.retainedLabels?.(path)) ?? [];
  const labels = retained.length === 0 ? [control.compartment] : normalizeLabels([control.compartment, ...retained]);
  await runtime.store.reconcileLabels(path, seen.digest, labels);
  runtime.control.audit({ kind: "label-reconciled", project: control.projectId, path, digest: seen.digest });
  return labels;
}

/** Observe one object for `permission`, or `null` when it is absent, unlabelled or uncleared. */
export async function observeVisible(
  runtime: ProjectRuntime, view: ReadView, path: string, permission: Permission,
): Promise<LabelledObservation | null> {
  // The verb and the project compartment are checked BEFORE any byte is
  // observed. In this prototype every object carries exactly that one
  // compartment, so this decides visibility ahead of the body. Per-object
  // labels are still bound to the digest read and checked below; a general
  // metadata-before-body path for several compartments is NOT implemented here.
  if (!(await holdsCompartment(runtime, permission))) return null;
  const seen = await view.observe(path);
  if (seen === null) return null;
  const labels = await labelsForObservation(runtime, view, path, seen);
  if (labels === null || !(await isVisible(runtime.control, runtime.principal, permission, labels))) return null;
  return { ...seen, labels };
}

/** True when the principal holds `permission` and clearance for the project compartment, now. */
async function holdsCompartment(runtime: ProjectRuntime, permission: Permission): Promise<boolean> {
  const control = await runtime.control.loadProject(runtime.principal.project);
  return control !== null && isVisible(runtime.control, runtime.principal, permission, [control.compartment]);
}

/** The page id of a concept page path. */
function pageIdOf(path: string): string {
  return path.slice(CONCEPTS_PREFIX.length).replace(/\.md$/u, "");
}

/** Read one published page. */
export async function getPage(runtime: ProjectRuntime, id: string): Promise<LabelledResult<PageView>> {
  await authorize(runtime.control, runtime.principal, "page.read");
  const path = conceptPagePath(id);
  const seen = await withProjectRead(runtime, (view) => observeVisible(runtime, view, path, "page.read"));
  if (seen === null) return { visible: false };
  const value = { id, path, digest: seen.digest, revision: seen.revision, body: UTF8.decode(seen.bytes) };
  return { visible: true, value, labels: seen.labels };
}

/** A page collected for a listing or a search, with the labels it was authorized under. */
interface CollectedPage extends PageListing { body: string; labels: LabelSet }

/** Every page the principal may read, collected in one consistent view. */
async function collectPages(runtime: ProjectRuntime, permission: Permission): Promise<CollectedPage[]> {
  return withProjectRead(runtime, async (view) => {
    const pages: CollectedPage[] = [];
    for (const path of await view.list(CONCEPTS_PREFIX)) {
      if (!path.endsWith(".md")) continue;
      const seen = await observeVisible(runtime, view, path, permission);
      if (seen === null) continue;
      const body = UTF8.decode(seen.bytes);
      const title = parseFrontmatter(body).meta.title;
      const id = pageIdOf(path);
      pages.push({ id, path, title: typeof title === "string" ? title : id, body, labels: seen.labels });
    }
    return pages;
  });
}

/**
 * Keep only what the principal may STILL be served, decided at delivery. A
 * role removed while results were being collected removes them here.
 */
async function deliverable<T extends { labels: LabelSet }>(
  runtime: ProjectRuntime, permission: Permission, items: readonly T[],
): Promise<T[]> {
  await authorize(runtime.control, runtime.principal, permission);
  const kept: T[] = [];
  for (const item of items) {
    if (await isVisible(runtime.control, runtime.principal, permission, item.labels)) kept.push(item);
  }
  return kept;
}

/** List published pages. */
export async function listPages(runtime: ProjectRuntime): Promise<Listed<PageListing>> {
  await authorize(runtime.control, runtime.principal, "page.list");
  const pages = await deliverable(runtime, "page.list", await collectPages(runtime, "page.list"));
  return { items: pages.map(({ id, path, title }) => ({ id, path, title })), notice: ACCESS_NOTICE };
}

/** Read one source's normalized text. */
export async function getSource(runtime: ProjectRuntime, id: string): Promise<LabelledResult<SourceView>> {
  await authorize(runtime.control, runtime.principal, "source.read");
  const path = sourcePath(id);
  const seen = await withProjectRead(runtime, (view) => observeVisible(runtime, view, path, "source.read"));
  if (seen === null) return { visible: false };
  const value = { id, path, digest: seen.digest, revision: seen.revision, text: UTF8.decode(seen.bytes) };
  return { visible: true, value, labels: seen.labels };
}

/**
 * Deterministic keyword search over published page text: no embeddings and no
 * model call. Only pages the principal may read are searched at all, so scores
 * and snippets never reflect anything withheld.
 */
export async function searchProject(runtime: ProjectRuntime, query: string): Promise<Listed<SearchHit>> {
  await authorize(runtime.control, runtime.principal, "query.run");
  const pages = await collectPages(runtime, "page.read");
  // The shared search reads only id, title and body of each page.
  const snapshot = {
    pages: pages.map((page) => ({ id: page.id, pageDirectory: "concepts", title: page.title, body: page.body })),
  } as unknown as ViewerSnapshot;
  const byId = new Map(pages.map((page) => [page.id, page]));
  const hits = searchPages(snapshot, query).results.flatMap((hit) => {
    const page = byId.get(String(hit.id));
    return page ? [{ id: page.id, path: page.path, title: hit.title, snippet: hit.snippet, labels: page.labels }] : [];
  });
  await authorize(runtime.control, runtime.principal, "query.run");
  const kept = await deliverable(runtime, "page.read", hits);
  return { items: kept.map(({ id, path, title, snippet }) => ({ id, path, title, snippet })), notice: ACCESS_NOTICE };
}
