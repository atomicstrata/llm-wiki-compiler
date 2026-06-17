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

/** How an entity type participates in search and context retrieval. */
export interface RetrievalDef {
  includeInSearch?: boolean;
  includeInContext?: boolean;
  defaultWeight?: number;
  readExposure?: "agent-readable" | "local-only";
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
