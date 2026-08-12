/**
 * Fixtures for the profile-vocabulary sidebar and its typed list routes.
 *
 * Every test here mounts the real viewer against an `/api/pages` envelope whose
 * only interesting field is `profilePipeline.entityTypes` — the block
 * `713ccfb` added and the block the nav projects. Passing `undefined` for it
 * produces a DEFAULT project's envelope, which is how the default-parity tests
 * get a sidebar that must not have moved.
 *
 * The readers below deliberately go through the rendered DOM rather than any
 * exported helper, so they measure what a reader would see.
 */

import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./viewer-jsdom.js";

/** The profile id a profile-project envelope reports. */
export const PROFILE_ID = "newsroom";

/** One entity type on the wire: its id, its declared directory, and its valid-page count. */
export interface EntityType {
  type: string;
  pageCount: number;
  /**
   * The profile's declared `directory` for this type: a canonical
   * PROJECT-RELATIVE path, which every shipped template spells `wiki/<name>`.
   * Required on the wire, and NOT interchangeable with the type id — the
   * collector scans this — so it is carried here rather than reconstructed by
   * any client under test.
   */
  directory?: string;
}

/** One page row, reduced to the fields a list route reads. */
export interface TypedPage {
  id: string;
  pageDirectory: string;
  slug: string;
  title: string;
  updatedAt: string;
  entityType?: string;
  /** Only the dashboard reads this; a list row shows it but never sums it. */
  citationCount?: number;
}

/**
 * Build the entity-type block from `[id, count, directory?]` tuples, in
 * declaration order. `directory` defaults to `wiki/<type>` — what every shipped
 * template declares — and is passed explicitly by the tests that need the
 * directory and the type id to diverge.
 */
export function types(...pairs: [string, number, string?][]): EntityType[] {
  return pairs.map(([type, pageCount, directory]) => ({
    type,
    pageCount,
    directory: directory ?? `wiki/${type}`,
  }));
}

/** `count` entity types named `type-0`… with descending page counts. */
export function manyTypes(count: number): EntityType[] {
  return Array.from({ length: count }, (_, i) => ({
    type: `type-${i}`,
    pageCount: count - i,
    directory: `wiki/type-${i}`,
  }));
}

/** Build a typed entity page row for `/api/pages.pages`. */
export function typedPage(
  entityType: string,
  slug: string,
  updatedAt: string,
  citationCount?: number,
): TypedPage {
  return {
    id: `${entityType}/${slug}`,
    pageDirectory: entityType,
    slug,
    title: slug.toUpperCase(),
    updatedAt,
    entityType,
    ...(citationCount === undefined ? {} : { citationCount }),
  };
}

/**
 * The bootstrap envelope; `entityTypes` absent means a DEFAULT project.
 *
 * `overrides` is merged last so a test can vary the fields its own surface
 * reads — source filenames for the list routes, counts and graph totals for the
 * dashboard — without a second envelope literal drifting away from this one.
 */
export function vocabularyEnvelope(
  entityTypes: EntityType[] | undefined,
  pages: TypedPage[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    project: { title: "demo", rootName: "demo" },
    stateStatus: "ok",
    profileId: entityTypes ? PROFILE_ID : "default",
    counts: { concepts: 7, queries: 0, sourceFiles: 1, pendingReviews: 0 },
    sourceFilenames: [],
    index: { available: false },
    recentPages: [],
    pages,
    ...(entityTypes ? { profilePipeline: { entityTypes } } : {}),
    ...overrides,
  };
}

/** Serve the bootstrap pair for `envelope`, plus the per-visit route endpoints. */
export function vocabularyResponder(envelope: unknown): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelope);
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.endsWith("/api/reviews")) return jsonResponse({ reviews: [], total: 0 });
    if (url.endsWith("/api/workflow-runs")) return jsonResponse({ runs: [] });
    return null;
  };
}

/**
 * The same responder with `/api/pages` held open until `release()` is called.
 *
 * `renderRoute` runs once before the envelope settles and again after, so a cold
 * deep link to a typed list route resolves to home on the first pass and
 * corrects itself on the second. Holding the fetch is the only way to observe
 * the first pass rather than only its outcome.
 */
export function deferredVocabularyResponder(envelope: unknown): {
  responder: FetchResponder;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled = vocabularyResponder(envelope);
  return {
    release,
    responder: (url) =>
      url.endsWith("/api/pages") ? gate.then(() => settled(url) as Response) : settled(url),
  };
}

/** Mount the viewer and return its document. */
export async function mountVocabulary(
  entityTypes: EntityType[] | undefined,
  options: { pages?: TypedPage[]; hash?: string } = {},
): Promise<Document> {
  const envelope = vocabularyEnvelope(entityTypes, options.pages);
  const { dom } = await mountViewerDom(vocabularyResponder(envelope), options.hash);
  await flushMicrotasks();
  return dom.window.document;
}

/** Mount and return the sidebar element. */
export async function mountVocabularySidebar(
  entityTypes: EntityType[] | undefined,
  hash?: string,
): Promise<HTMLElement> {
  const doc = await mountVocabulary(entityTypes, { hash });
  return doc.querySelector(".sidebar") as HTMLElement;
}

/** One nav entry as the sidebar rendered it. */
export interface NavEntry {
  route: string;
  href: string;
  label: string;
}

/** Every nav entry in the BROWSE section, in rendered order. */
export function browseEntries(sidebar: HTMLElement): NavEntry[] {
  const browse = sidebar.querySelectorAll(".nav-section")[0];
  return Array.from(browse?.querySelectorAll("a[data-route]") ?? []).map((a) => ({
    route: a.getAttribute("data-route") ?? "",
    href: a.getAttribute("href") ?? "",
    label: a.querySelector(".nav-label")?.textContent ?? "",
  }));
}

/** The type-row routes only, in rendered order. */
export function typeRows(sidebar: HTMLElement): string[] {
  return Array.from(sidebar.querySelectorAll(".nav-type-list a[data-route]")).map(
    (a) => a.getAttribute("data-route") ?? "",
  );
}

/** The profile name shown on the BROWSE header, or null when there is none. */
export function browseProfileName(sidebar: HTMLElement): string | null {
  return sidebar.querySelector(".nav-section-profile")?.textContent ?? null;
}
