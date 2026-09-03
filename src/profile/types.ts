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

import path from "path";
import { toPosixPath } from "../utils/path-confine.js";
import type { ConnectorBindingDef } from "../connectors/types.js";
import type { EntityProblem, EntityProblemKind } from "./collect.js";

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
  | "string[]"
  | "artifactRef"
  | "artifactRef[]";

/**
 * Declarative PRESENTATION hints for a text field: enough for a read surface to
 * build an external link generically, and nothing more.
 *
 * A CLOSED vocabulary rather than a URL template. A template would be an
 * author-supplied string a renderer interpolates into an href — executable
 * profile behaviour reaching a read surface — whereas these three name a
 * resolver the READER already knows, so the origin stays out of profile control.
 * An unknown value is rejected at load, so no renderer has to guess.
 */
export type FieldFormat = "url" | "doi" | "arxiv";

/** Declarative definition of a single frontmatter field on an entity type. */
export interface FieldDef {
  type: FieldType;
  /**
   * How a read surface may linkify this field's text. Valid only on `string` and
   * `string[]` (see `validateTitleField`'s neighbour in validate.ts): a format is
   * a hint about how to read text, and on any other type it would be config no
   * renderer could act on.
   */
  format?: FieldFormat;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  /** For artifactRef fields: the declared artifact types this ref may point at (omitted = any). */
  artifactTypes?: string[];
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

/**
 * A relation-count precondition on ENTERING a lifecycle state: THIS lifecycle's
 * entity must be an endpoint of at least `minCount` instances of `relationType`
 * on its `role` side (optionally narrowed to `otherTypes` on the opposite side).
 *
 * Declarative + load-validated in `./validate-relation-requirements.ts`; a
 * malformed or structurally-unsatisfiable requirement fails the profile LOAD.
 * ENFORCED at write time by `../relations/enforce-precondition.ts` (composed at
 * every live typed-page apply path) and re-checked as a standing invariant on
 * the read surfaces by `./relation-standing.ts`.
 */
export interface RelationCountReq {
  /** A DECLARED relation type whose instances are counted. */
  relationType: string;
  /** Whether THIS lifecycle's entity is the from- or to-endpoint of `relationType`. */
  role: "from" | "to";
  /**
   * Allowed entity types of the OTHER endpoint; omitted = any. Each entry must be
   * a declared entity AND a legal opposite-side endpoint of `relationType`.
   */
  otherTypes?: string[];
  /**
   * Allowed CURRENT lifecycle states of the OTHER endpoint for a relation to
   * count; omitted = any state (or no lifecycle at all). Enforcement is
   * FAIL-CLOSED: when set, an endpoint whose type declares no lifecycle, or
   * whose page carries no lifecycle-field value, does NOT qualify. Load-validated
   * in `./validate-relation-requirements.ts`: non-empty, entries unique, each a
   * declared lifecycle state of an allowed other endpoint type.
   */
  otherStates?: string[];
  /** Minimum required instance count; a finite integer >= 1. */
  minCount: number;
}

/**
 * An artifact-existence precondition on ENTERING a lifecycle state: the entity's
 * declared `field` (an `artifactRef`/`artifactRef[]` field) must carry a pinned ref that
 * RESOLVES HEALTHY to an artifact of `artifactType`. EXISTENCE/health only — semantic
 * coverage is a NON-GOAL (OQ11), so there is deliberately NO `minCount`. Load-validated
 * in `./validate-artifact-requirements.ts` (M1/M3); ENFORCED at write time by
 * `../artifacts/enforce-precondition.ts`.
 */
export interface ArtifactPreconditionReq {
  /** A declared `artifactRef`/`artifactRef[]` field of THIS entity whose ref must resolve healthy. */
  field: string;
  /** The declared artifact type the ref must be. */
  artifactType: string;
}

/** A state-machine lifecycle defined over one frontmatter field. */
export interface LifecycleDef {
  field: string;
  initial: string;
  terminal: string[];
  transitions: Record<string, string[]>;
  transitionRequirements?: Record<string, string[]>;
  /**
   * Optional per-state relation-count preconditions, keyed by the state being
   * ENTERED. Omitted-for-default: a lifecycle without this key behaves exactly as
   * before. Load-validated in `./validate-relation-requirements.ts`; ENFORCED at
   * write time by `../relations/enforce-precondition.ts` on every live typed-page
   * apply path, and re-evaluated against the CURRENT relation graph on the read
   * surfaces by `./relation-standing.ts` (standing-invariant drift detection).
   */
  transitionRelationRequirements?: Record<string, RelationCountReq[]>;
  /**
   * Optional per-state artifact-existence preconditions, keyed by the state being
   * ENTERED. Omitted-for-default. Load-validated in `./validate-artifact-requirements.ts`;
   * ENFORCED at write time by `../artifacts/enforce-precondition.ts`. See {@link ArtifactPreconditionReq}.
   */
  transitionArtifactRequirements?: Record<string, ArtifactPreconditionReq[]>;
}

/**
 * Declarative definition of one typed relation type within a profile pack.
 *
 * A relation type declares its endpoints by entity-type id (`from`/`to`, each a
 * non-empty list of DECLARED entity types), a `direction` (`directed` keeps the
 * endpoint roles distinct; `symmetric` treats them as an unordered pair —
 * canonicalization of symmetric pairs is enforced at STORE time in a later
 * slice, not here), and optionally a set of typed `attributes` (reusing the same
 * {@link FieldDef} contract as entity fields) with a `requiredAttributes`
 * subset that must reference declared attribute keys.
 *
 * This is SCHEMA + VALIDATION only: there is no relation store or write path in
 * this slice. The DEFAULT profile declares no relations, so the whole block is
 * omitted-for-default and never appears in default output or digest.
 */
export interface RelationTypeDef {
  /** Endpoint entity-type ids on the `from` side; each must be a declared entity. */
  from: string[];
  /** Endpoint entity-type ids on the `to` side; each must be a declared entity. */
  to: string[];
  /** `directed` keeps endpoint roles distinct; `symmetric` treats them as unordered. */
  direction: "directed" | "symmetric";
  /** Typed relation attributes, validated with the same {@link FieldDef} contract as fields. */
  attributes?: Record<string, FieldDef>;
  /** Attribute keys (subset of `attributes`) that must be present on a relation instance. */
  requiredAttributes?: string[];
}

/** One stage of a declarative workflow: what it reads/writes and an optional gate. */
export interface WorkflowStageDef {
  /** Slug-safe stage id, unique within its workflow. */
  id: string;
  /** Declared entity-type ids this stage reads. */
  reads: string[];
  /** Declared entity-type ids this stage writes. */
  writes: string[];
  /**
   * OPTIONAL declared artifact-type ids this stage may PRODUCE as an artifact
   * stage output (P-A). Omitted-for-default: a stage without this key produces no
   * artifacts, so default profiles stay byte-identical. Validated against the
   * profile's declared artifact types at load.
   */
  artifactWrites?: string[];
  /** Optional gate, `<kind>:<id>` where kind ∈ {trust,human,agent}. */
  gate?: string;
  /**
   * Prior stage ids this stage was renamed FROM; lets an in-flight run on an old
   * id be adapted rather than blocked.
   */
  previousIds?: string[];
}

/** A declarative, non-executable workflow definition. */
export interface WorkflowDef {
  stages: WorkflowStageDef[];
  /** Optional project-relative markdown projection target (validated in a later slice). */
  projectionFile?: string;
}

/** The capability classes, ordinal: disabled < read-only < staged-write < trusted-write. */
export type CapabilityClass = "disabled" | "read-only" | "staged-write" | "trusted-write";

/** The surfaces an action can be invoked through. */
export type ActionSurface = "cli" | "sdk" | "mcp" | "viewer";

/** One declarative input field of an action's inputSchema. */
export interface ActionInputField {
  type: "string" | "string[]" | "entityRef" | "number" | "boolean";
  required?: boolean;
  default?: unknown;
  /** For type "entityRef": the declared entity types the ref may point to. */
  entityTypes?: string[];
}

/** A declarative workflow action: a shortcut resolving to a workflow operation. */
export interface WorkflowActionDef {
  label: string;
  /** The declared workflow this action operates on. */
  workflow: string;
  operation: "start" | "resume" | "advance" | "gate" | "cancel" | "fail" | "status" | "submit";
  inputSchema?: Record<string, ActionInputField>;
  /** Per-surface REQUESTED capability (a request, not a grant). All 4 surfaces required. */
  permissions: Record<ActionSurface, CapabilityClass>;
  /** A human:/agent: gate this action satisfies (operation "gate"). */
  gate?: string;
  /** A trust: gate this action's write must pass. */
  trustGate?: string;
}

/**
 * The reserved `contentTiers` token that reveals a record's markdown BODY (as
 * opposed to a declared frontmatter field). Shared by the load validator and the
 * context projection so the one reserved literal is spelled exactly once.
 */
export const BODY_TIER_TOKEN = "body";

/** Declarative definition of one entity type within a profile pack. */
export interface EntityTypeDef {
  directory: string;
  titleField?: string;
  requiredFields?: string[];
  fields?: Record<string, FieldDef>;
  retrieval?: RetrievalDef;
  lifecycle?: LifecycleDef;
  /**
   * Optional shallowest-first per-record content-depth tiers for progressive
   * context revelation: each entry is either a declared field name of this entity
   * type OR the reserved {@link BODY_TIER_TOKEN}. OMITTED-for-default — a type
   * WITHOUT this key behaves exactly as today: its context primaries carry no
   * `contentTiers`, so default packs stay byte-identical. Load-validated in
   * `validate.ts`; consumed by the context projection in `context/content-tiers.ts`.
   */
  contentTiers?: string[];
  export?: { okfType?: string };
}

/** A profile-declared artifact type: a typed, content-addressed leaf file. */
export interface ArtifactTypeDef {
  /** Leaf filename: safe-filename grammar + allowlisted extension (see src/artifacts/name.ts). */
  fileName: string;
  /** v0 content kinds. */
  contentKind: "json" | "text";
  /** Inclusive UTF-8 byte ceiling, enforced on the handle before any read/hash. */
  maxBytes: number;
  /** OPTIONAL partial scalar field-contract over top-level JSON object fields (json only). */
  metadata?: Record<string, FieldDef>;
}

/** A profile pack: the full declarative description of a wiki's entity types. */
export interface ProfilePack {
  schemaVersion: 1;
  profileId: string;
  profileVersion?: string;
  displayName?: string;
  extends?: string[];
  entities: Record<string, EntityTypeDef>;
  /**
   * Typed relation type declarations, keyed by slug-safe relation-type id.
   * OPTIONAL and omitted-for-default: a relation-less profile (including the
   * built-in default) carries no `relations` key, so its digest and output are
   * unchanged. See {@link RelationTypeDef}.
   */
  relations?: Record<string, RelationTypeDef>;
  /**
   * Optional declarative workflow declarations, keyed by slug-safe workflow id.
   * OPTIONAL and omitted-for-default: a workflow-less profile (incl. the built-in
   * default) carries no `workflows` key, so its digest and output are unchanged.
   * See {@link WorkflowDef}. Validated fail-closed in validate.ts; never executable.
   */
  workflows?: Record<string, WorkflowDef>;
  /**
   * Optional declarative workflow-action declarations, keyed by a slug-safe DOTTED
   * id (`<domain>.<action>`). OPTIONAL and omitted-for-default: an action-less
   * profile (incl. the built-in default) carries no `workflowActions` key, so its
   * digest and output are unchanged. Each action is a SHORTCUT that resolves to a
   * workflow operation; see {@link WorkflowActionDef}. Validated fail-closed in
   * validate.ts — SCHEMA + TYPES + VALIDATION only, with no authority model,
   * execution, or CLI surface in this slice.
   */
  workflowActions?: Record<string, WorkflowActionDef>;
  /**
   * Optional profile-declared artifact type declarations, keyed by slug-safe id.
   * OPTIONAL and omitted-for-default: an artifact-less profile (incl. the built-in
   * default) carries no `artifacts` key, so its digest and output are unchanged.
   * See {@link ArtifactTypeDef}. Validated fail-closed in validate.ts.
   */
  artifacts?: Record<string, ArtifactTypeDef>;
  /**
   * Optional pure-data connector bindings, keyed by registered connector id.
   * OPTIONAL and omitted-for-default: connector-less profiles carry no
   * `connectors` key and never activate external fetch surfaces.
   */
  connectors?: Record<string, ConnectorBindingDef>;
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
 * resolved from the type's declared `titleField` (falling back to the literal
 * `title` key for a type that declares none), or `undefined` when the page
 * carries no usable one. It is produced by the content-carrying collector so
 * downstream read surfaces can render a page without re-reading it. Surfaces
 * that must judge or publish what the page literally WROTE read the frontmatter
 * key directly instead — see `pageTitle` in collect.ts.
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

/**
 * The PUBLIC surface DTO for a structured non-default-profile collector problem.
 *
 * Unlike the internal {@link EntityProblem}, this NEVER carries an absolute
 * `filePath` — only a PROJECT-RELATIVE `path` (`path.relative(root, filePath)`),
 * which is OMITTED entirely (key absent) for directory-level problems that have
 * no file. Carrying the structured `kind`/`entityType` (rather than a flattened
 * message string) lets a surface group, count, or filter problems, and keeps
 * repeated field violations distinguishable.
 *
 * @experimental Shape may change in a future release.
 */
export interface EntityProblemView {
  /**
   * The problem kind. An entity-page/dir collector problem ({@link EntityProblemKind});
   * `"relation-store"` for a fail-closed relation-store read (corrupt / too-new);
   * `"event-store"` for a fail-closed event-store read OR a broken/truncated
   * hash chain;
   * `"artifact-store"` for a hash-pinned artifactRef (page field or relation
   * attribute) that resolves to a non-`ok` health (dangling / bytes-tampered /
   * hash-mismatch / schema-invalid / unreadable / store-unavailable) — see
   * `./artifact-lint.js`;
   * `"lifecycle-relation-requirement-unmet"` for a page CURRENTLY in a gated
   * lifecycle state whose relation-count precondition NO LONGER holds against the
   * live relation graph (a standing-invariant violation);
   * `"lifecycle-relation-requirement-unverifiable"` when that standing check could
   * NOT read the relation store (cannot verify, not a confirmed violation). The
   * store-level and standing kinds are surfaced through the SAME problems channel
   * so a status/viewer envelope never reports a degraded project as silently healthy.
   */
  kind:
    | EntityProblemKind
    | "relation-store"
    | "event-store"
    | "artifact-store"
    | "lifecycle-relation-requirement-unmet"
    | "lifecycle-relation-requirement-unverifiable";
  /**
   * Declared entity type the problem belongs to. ABSENT for a store-level
   * (`relation-store`) problem, which is not scoped to any entity type.
   */
  entityType?: string;
  /**
   * Project-relative offending page path; ABSENT for directory-level problems.
   * Never absolute, and always `/`-separated on every platform — this is
   * portable content, not a filesystem argument.
   */
  path?: string;
  message: string;
}

/**
 * Map an internal {@link EntityProblem} to its public {@link EntityProblemView}.
 *
 * Drops the absolute `filePath` in favour of a project-relative `path`,
 * OMITTING the key entirely when the problem is directory-level (no `filePath`)
 * so an absent path is never a misleading empty string and an absolute path can
 * never leak.
 *
 * The relative path is forced back to POSIX: `path.relative` emits the PLATFORM
 * separator, so on win32 this public view would otherwise promise
 * `wiki/notes/x.md` and hand every consumer `wiki\notes\x.md` (issue #163, one
 * layer out from the declared-path fix).
 *
 * @param problem - The internal structured collector problem.
 * @param root - Absolute project root, used to relativize `filePath`.
 * @returns The public, path-safe problem view.
 */
export function toEntityProblemView(problem: EntityProblem, root: string): EntityProblemView {
  return {
    kind: problem.kind,
    entityType: problem.entityType,
    ...(problem.filePath !== undefined ? { path: toPosixPath(path.relative(root, problem.filePath)) } : {}),
    message: problem.message,
  };
}
