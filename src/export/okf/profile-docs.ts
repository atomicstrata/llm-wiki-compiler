/**
 * @file Collect a non-default profile's live entity pages and render each as an
 * OKF document for the bundle.
 *
 * Profile-aware extension of the OKF export (CLP 7.6, D-7.6.3/10/12): for a
 * project with a NON-DEFAULT profile, every declared entity type's live pages are
 * rendered into the bundle at `<entityType>/<slug>.md`. Each doc's OKF `type` is
 * the entity type's `export.okfType` when set (else the entity type id), and its
 * `x-llmwiki` block additionally carries `entityType` and — for a
 * lifecycle-declaring type whose page holds a state — `lifecycle: { field, state }`.
 * The x-okf re-export honesty mechanism (D-7.6.12) is unchanged: unknown foreign
 * frontmatter keys survive staging/promotion exactly as they do for concept docs.
 *
 * DEFAULT PARITY (D-7.6.10, hard invariant): the whole module is gated on
 * {@link loadNonDefaultProfile} returning a non-default profile, so a
 * default-profile project yields NO entity docs and the bundle stays
 * byte-identical to a pre-7.6 export.
 */
import { collectEntityPages } from "../../profile/collect.js";
import type { EntityPage, EntityTypeDef, LoadedProfile, ProfilePack } from "../../profile/types.js";
import { buildFrontmatter } from "../../utils/markdown.js";
import { canonicalBody, hashCanonicalBody, wikilinksToOkf } from "./mapping.js";
import type { LinkResolver } from "./types.js";

/** A rendered entity OKF document plus the metadata the index TOC needs. */
export interface ProfileEntityDoc {
  /** Declared entity type id (e.g. `papers`) — the TOC groups on this. */
  entityType: string;
  /** Bundle-relative output path: `<entityType>/<slug>.md`. */
  rel: string;
  /** Display title for the TOC (frontmatter title, else the slug). */
  title: string;
  /** One-line summary for the TOC (frontmatter `summary`, else empty). */
  summary: string;
  /** The fully rendered OKF document (frontmatter + rewritten body). */
  content: string;
}

/**
 * OKF reserved frontmatter keys a declared DOMAIN field cannot share at the top
 * level: a same-named domain field is routed to `x-llmwiki.fields` instead so it
 * never shadows the OKF standard mapping (mirrors the import RESERVED set).
 */
const RESERVED_OKF_KEYS = new Set(["type", "title", "description", "tags", "timestamp", "x-llmwiki", "x-okf"]);

/** Read a string frontmatter field, or undefined when absent/non-string. */
function readString(frontmatter: Record<string, unknown>, field: string): string | undefined {
  const value = frontmatter[field];
  return typeof value === "string" ? value : undefined;
}

/** The declared domain fields present on a page, split by whether their name collides with a reserved OKF key. */
interface DomainFields {
  /** Non-reserved field names → emitted at the OKF frontmatter top level. */
  top: Record<string, unknown>;
  /** Reserved-name collisions → emitted under `x-llmwiki.fields`. */
  collided: Record<string, unknown>;
}

/**
 * Collect every DECLARED entity field PRESENT on the live page's frontmatter,
 * verbatim (D-7.6.3 domain-field export; the T4-found gap). A `title` field is
 * omitted here — its value already flows to the OKF standard `title` key, so
 * re-emitting it would duplicate. Reserved-name collisions (`type`, `description`,
 * `tags`, `timestamp`, …) are separated so the caller nests them under
 * `x-llmwiki.fields` rather than shadowing the standard OKF keys.
 */
function collectDomainFields(page: EntityPage, def: EntityTypeDef): DomainFields {
  const top: Record<string, unknown> = {};
  const collided: Record<string, unknown> = {};
  for (const name of Object.keys(def.fields ?? {})) {
    if (name === "title" || !(name in page.frontmatter)) continue;
    const value = page.frontmatter[name];
    if (value === undefined) continue;
    if (RESERVED_OKF_KEYS.has(name)) collided[name] = value;
    else top[name] = value;
  }
  return { top, collided };
}

/**
 * The explicit `lifecycle: { field, state }` sub-block for a doc, or undefined
 * when the entity type declares no lifecycle OR the page carries no value in the
 * lifecycle field (per D-7.6.3: omit the block rather than emit a partial one).
 */
function readLifecycle(
  page: EntityPage,
  def: EntityTypeDef,
): { field: string; state: string } | undefined {
  const lifecycle = def.lifecycle;
  if (lifecycle === undefined) return undefined;
  const state = readString(page.frontmatter, lifecycle.field);
  return state === undefined ? undefined : { field: lifecycle.field, state };
}

/**
 * Build the entity doc's `x-llmwiki` block: standard contentHash + entityType +
 * optional lifecycle + optional `fields` (the reserved-name-collision domain
 * fields, so a `description`/`tags`/… field survives without shadowing the OKF
 * standard key).
 */
function buildEntityXLlmwiki(page: EntityPage, def: EntityTypeDef, collided: Record<string, unknown>): Record<string, unknown> {
  const lifecycle = readLifecycle(page, def);
  return {
    schemaVersion: "0.1",
    contentHash: hashCanonicalBody(page.body),
    entityType: page.entityType,
    ...(lifecycle ? { lifecycle } : {}),
    ...(Object.keys(collided).length > 0 ? { fields: collided } : {}),
  };
}

/**
 * Overlay the OKF standard fields (title/description/tags/timestamp) from the
 * entity page's frontmatter.
 *
 * `title` is read from the LITERAL frontmatter key, not from `EntityPage.title`.
 * That field now resolves through `EntityTypeDef.titleField`, and using it here
 * would widen a published interchange format: a `desks` record keyed `name`
 * would gain an OKF `title` it never had, while `collectDomainFields` — which
 * suppresses only a field literally named `title` — would keep exporting `name`
 * too, shipping one value under two keys. A display title is a viewer and TOC
 * concern (see {@link toEntityDoc}, which does use the resolved title); the
 * bundle carries what the page actually wrote.
 */
function applyEntityStandardFields(fm: Record<string, unknown>, page: EntityPage): void {
  const title = readString(page.frontmatter, "title");
  if (title) fm.title = title;
  const description = readString(page.frontmatter, "summary");
  if (description) fm.description = description;
  const tags = page.frontmatter.tags;
  if (Array.isArray(tags) && tags.length > 0) fm.tags = tags;
  const timestamp = readString(page.frontmatter, "updatedAt");
  if (timestamp) fm.timestamp = timestamp;
}

/**
 * Entity page -> OKF frontmatter: `type` = okfType hook ?? entityType, then the
 * declared domain fields (non-reserved at the top level, reserved-name collisions
 * under `x-llmwiki.fields`), the entity `x-llmwiki` block, and the OKF standard
 * fields last (title/description/tags/timestamp reflect the current page).
 */
function buildEntityFrontmatter(page: EntityPage, def: EntityTypeDef): Record<string, unknown> {
  const { top, collided } = collectDomainFields(page, def);
  const fm: Record<string, unknown> = {
    type: def.export?.okfType ?? page.entityType,
    "x-llmwiki": buildEntityXLlmwiki(page, def, collided),
    ...top,
  };
  applyEntityStandardFields(fm, page);
  return fm;
}

/** Render one entity page as a full OKF `.md` document (frontmatter + body with wikilinks rewritten). */
function renderEntityDoc(page: EntityPage, def: EntityTypeDef, resolve: LinkResolver): string {
  const frontmatter = buildFrontmatter(buildEntityFrontmatter(page, def));
  const rewritten = wikilinksToOkf(canonicalBody(page.body), resolve);
  return `${frontmatter}\n${rewritten}`;
}

/** Map a collected entity page to its bundle doc (path, TOC metadata, rendered content). */
function toEntityDoc(page: EntityPage, def: EntityTypeDef, resolve: LinkResolver): ProfileEntityDoc {
  return {
    entityType: page.entityType,
    rel: `${page.entityType}/${page.slug}.md`,
    title: page.title ?? page.slug,
    summary: readString(page.frontmatter, "summary") ?? "",
    content: renderEntityDoc(page, def, resolve),
  };
}

/** Total order over docs: entity type, then bundle path (stable, deterministic bundle output). */
function compareDocs(a: ProfileEntityDoc, b: ProfileEntityDoc): number {
  if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/**
 * Collect the ACTIVE non-default profile's live entity pages, each rendered as an
 * OKF document for the bundle. Returns `[]` for a default-profile project
 * (byte-identical parity, D-7.6.10) and never throws on page data — the shared
 * collector surfaces bad pages as problems and still yields their valid siblings.
 *
 * The `loaded` profile is threaded in from the caller so the export loads (and
 * validates) it ONCE across every profile-aware surface; `undefined` means the
 * default profile and yields no docs.
 *
 * @param root - Absolute project root directory.
 * @param resolve - Wikilink resolver over the bundle's native pages; entity-page
 *   bodies reuse it so an entity->concept link rewrites to its OKF target.
 * @param loaded - The active non-default profile, or `undefined` for the default.
 * @returns The rendered entity docs, sorted by entity type then bundle path.
 */
export async function collectProfileEntityDocs(
  root: string,
  resolve: LinkResolver,
  loaded: LoadedProfile | undefined,
): Promise<ProfileEntityDoc[]> {
  if (loaded === undefined) return [];
  const { pages } = await collectEntityPages(root, loaded.profile);
  const docs = pages.map((page) => toEntityDoc(page, entityDef(loaded.profile, page), resolve));
  return docs.sort(compareDocs);
}

/** The declared entity-type def for a collected page (always present — the collector only yields declared types). */
function entityDef(profile: ProfilePack, page: EntityPage): EntityTypeDef {
  return profile.entities[page.entityType];
}
