/**
 * Profile pack type definitions (schemaVersion 1, v0).
 *
 * A profile pack describes the entity types a wiki compiles into: their
 * directories, fields, retrieval behaviour, and lifecycle. This is the v0
 * surface — purely declarative. There is intentionally NO computed-field or
 * required-if logic yet; those are deferred to a later schema version.
 *
 * Identity is modelled with branded string types so that a raw filesystem
 * stem can never be mistaken for a validated slug or entity id at compile
 * time. The only way to obtain a SlugSafe or EntityId is through the
 * constructors in `./identity.js`.
 */

/** A string proven to match the slug-safe grammar (`^[a-z0-9][a-z0-9-]*$`). */
export type SlugSafe = string & { readonly __slugSafe: unique symbol };

/** A composed, validated `type/slug` entity identifier. */
export type EntityId = string & { readonly __entityId: unique symbol };

/** The supported scalar/array field types for a profile entity field. */
export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "slug"
  | "enum"
  | "string[]";

/** Declarative definition of a single frontmatter field on an entity type. */
export interface FieldDef {
  type: FieldType;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
}

/**
 * How an entity type participates in search and context retrieval.
 *
 * NOTE: a read-confidentiality control (`readExposure`) was intentionally
 * removed for v0 — nothing enforces it this slice, and shipping an unenforced
 * confidentiality field is false assurance. It returns in the phase that
 * actually enforces read-confidentiality.
 */
export interface RetrievalDef {
  includeInSearch?: boolean;
  includeInContext?: boolean;
  defaultWeight?: number;
}

/** A state-machine lifecycle defined over one frontmatter field. */
export interface LifecycleDef {
  field: string;
  initial: string;
  terminal: string[];
  transitions: Record<string, string[]>;
  transitionRequirements?: Record<string, string[]>;
}

/** Declarative definition of one entity type within a profile pack. */
export interface EntityTypeDef {
  directory: string;
  titleField?: string;
  requiredFields?: string[];
  fields?: Record<string, FieldDef>;
  retrieval?: RetrievalDef;
  lifecycle?: LifecycleDef;
  export?: { okfType?: string };
}

/** A profile pack: the full declarative description of a wiki's entity types. */
export interface ProfilePack {
  schemaVersion: 1;
  profileId: string;
  profileVersion?: string;
  displayName?: string;
  extends?: string[];
  entities: Record<string, EntityTypeDef>;
}

/** A profile resolved from disk (or built-in), with its source and digest. */
export interface LoadedProfile {
  profile: ProfilePack;
  loadedFrom: string | null;
  digest: string;
}

/**
 * A reference to a single entity page on disk, carrying its validated slug
 * and minted id.
 *
 * EntityPageRef and EntityId are for NON-DEFAULT profiles only. Default-profile
 * pages keep their raw filesystem stems in RawWikiPage and never become an
 * EntityId — the default pipeline does not validate or mint identities.
 */
export interface EntityPageRef {
  entityType: string;
  directory: string;
  slug: SlugSafe;
  id: EntityId;
  filePath: string;
}

/**
 * A non-default profile entity page: identity (`EntityPageRef`) plus content.
 *
 * Where `EntityPageRef` is identity-only, `EntityPage` additionally carries the
 * page's parsed `frontmatter`, its markdown `body`, and a convenience `title`
 * (the frontmatter title when present). It is produced by the content-carrying
 * collector so downstream read surfaces can render a page without re-reading it.
 *
 * This is the INTERNAL collector output: it carries an ABSOLUTE `filePath`
 * (inherited from `EntityPageRef`). Never expose it directly on a public read
 * surface — map it through {@link toEntityPageView} first so the machine-local
 * path is dropped in favour of a project-relative one.
 */
export interface EntityPage extends EntityPageRef {
  frontmatter: Record<string, unknown>;
  body: string;
  title?: string;
}

/**
 * The PUBLIC surface DTO for a non-default profile entity page.
 *
 * Unlike the internal {@link EntityPage}, this NEVER carries an absolute
 * `filePath` — only a PROJECT-RELATIVE `path` (`${directory}/${slug}.md`) — so
 * read surfaces (`listPages`, JSON export) cannot leak machine-local paths. The
 * `body` is OPTIONAL and OMITTED entirely (not blanked to `""`) when the caller
 * did not request it, so an absent body is distinguishable from a genuinely
 * empty page.
 *
 * @experimental Shape may change in a future release.
 */
export interface EntityPageView {
  entityType: string;
  directory: string;
  slug: string;
  id: string;
  /** Project-relative page path (`${directory}/${slug}.md`); never absolute. */
  path: string;
  title?: string;
  frontmatter: Record<string, unknown>;
  /** Markdown body; OMITTED (key absent) when bodies were not requested. */
  body?: string;
}

/**
 * Map an internal {@link EntityPage} to its public {@link EntityPageView}.
 *
 * Drops the absolute `filePath` in favour of the project-relative `path`, and
 * OMITS `body` entirely when `includeBody` is false (mirroring how the legacy
 * `Page` shape omits — rather than blanks — an unrequested body).
 *
 * @param page - The internal collector entity page.
 * @param includeBody - When true, carry the markdown body into the view.
 * @returns The public, path-safe entity-page view.
 */
export function toEntityPageView(page: EntityPage, includeBody: boolean): EntityPageView {
  const view: EntityPageView = {
    entityType: page.entityType,
    directory: page.directory,
    slug: page.slug,
    id: page.id,
    path: `${page.directory}/${page.slug}.md`,
    frontmatter: page.frontmatter,
    ...(page.title !== undefined ? { title: page.title } : {}),
    ...(includeBody ? { body: page.body } : {}),
  };
  return view;
}
