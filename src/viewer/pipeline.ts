/**
 * The viewer's Pipeline read model: what the active profile DECLARES about each
 * entity type's lifecycle and each relation type's endpoints, joined with the
 * counts the profile summary already collects.
 *
 * The counts were always there — `entityCounts` (VALID pages only) and
 * `lifecycleStates` (the UNFILTERED tally) live on {@link ProfileSummaryBlock},
 * which `status`, the viewer and the JSON export all share. The DECLARATIONS
 * were not: `lifecycle` and `relations` live on the loaded profile pack and
 * stopped at the loader. They are projected HERE, in the viewer, rather than
 * added to that shared block, for two reasons: the block is a COUNT summary that
 * three unrelated surfaces pin field-for-field, and a lifecycle declaration is
 * not a count; and the viewer already loads the profile pack once
 * (`collectTypedViewerInputs`), so projecting alongside that load costs nothing
 * and cannot see a different profile than the typed pages did.
 *
 * The projection is deliberately DECLARATION-ONLY. It emits `initial`,
 * `terminal` and `transitions` and NOT the transition chain the panel draws:
 * the chain is derived on the client from those three, so there is exactly one
 * definition of "what order are these states in" and it is the profile's.
 */

import type { ProfileSummaryBlock } from "../profile/block.js";
import type {
  ArtifactTypeDef,
  EntityTypeDef,
  FieldDef,
  ProfilePack,
  RelationTypeDef,
} from "../profile/types.js";

/**
 * Facets of {@link FieldDef} the wire deliberately DROPS.
 *
 * `default` can carry an arbitrary author-supplied value that was never written
 * with a read surface in mind; `min`/`max` are write-time validation bounds no
 * renderer draws. Naming them here rather than omitting them silently is what
 * makes {@link PROJECTED_FIELD_FACETS} exhaustive — see the note there.
 */
type DroppedFieldFacet = "default" | "min" | "max";

/** Every {@link FieldDef} facet that reaches the client. */
type ProjectedFieldFacet = Exclude<keyof FieldDef, DroppedFieldFacet>;

/** One entity type's declared lifecycle, as the client receives it. */
export interface PipelineLifecycle {
  /** The frontmatter field the state lives in. */
  field: string;
  initial: string;
  terminal: string[];
  transitions: Record<string, string[]>;
  /**
   * The lifecycle field's declared enum values. Present only when `field` maps
   * to a declared enum field — which is the normal case, since load validation
   * requires that enum to equal the lifecycle's state set. Carried anyway
   * because it is what a page is VALIDATED against: a tallied state absent from
   * it was never a legal value, which is a different (and worse) finding than a
   * legal state the transition graph cannot reach.
   */
  declaredStates?: string[];
}

/**
 * One declared field as the client receives it: its frontmatter key plus every
 * projected facet the type actually declares.
 *
 * Derived from {@link FieldDef} rather than hand-listed, so the two cannot drift:
 * a facet added to `FieldDef` appears here automatically and must then be either
 * projected or added to {@link DroppedFieldFacet}.
 */
export type PipelineFieldDef = { name: string } & Pick<FieldDef, ProjectedFieldFacet>;

/**
 * One artifact type's declaration, as the client receives it.
 *
 * `maxBytes` is not projected: it is a read/write ceiling enforced on the
 * handle, not something a reader is shown. It belongs here the day a surface
 * renders it, not before.
 */
export interface PipelineArtifactTypeDef {
  type: string;
  fileName: string;
  contentKind: ArtifactTypeDef["contentKind"];
  /** Declared metadata contract, through the SAME field projection; absent when none. */
  metadata?: PipelineFieldDef[];
}

/** One entity type's declaration, before counts are joined onto it. */
export interface PipelineEntityTypeDef {
  type: string;
  /**
   * The wiki subdirectory the profile DECLARES for this type.
   *
   * Carried because it is independently declared and required — `profile/collect.ts`
   * scans `def.directory`, never the type id — so the two are free to differ
   * (`ideas` stored under `ideas-v2/`). A client that reconstructs the directory
   * from the type id is guessing, and when it guesses wrong it tells an author to
   * write pages somewhere the collector never reads.
   */
  directory: string;
  /**
   * The frontmatter key this type's display title is read from; absent when the
   * type declares none and the literal `title` key applies.
   */
  titleField?: string;
  /**
   * Declared fields IN DECLARATION ORDER — the order the profile author chose.
   * Absent when the type declares none.
   *
   * An ordered array rather than a map: object key order is not a contract a
   * client should have to trust, and the author's order is the only one not
   * invented by this projection.
   */
  fields?: PipelineFieldDef[];
  lifecycle?: PipelineLifecycle;
}

/** One relation type's declaration, before its live count is joined onto it. */
export interface PipelineRelationTypeDef {
  type: string;
  from: string[];
  to: string[];
  direction: RelationTypeDef["direction"];
}

/** Everything the active profile declares that the Pipeline panel draws. */
export interface PipelineDefinitions {
  entityTypes: PipelineEntityTypeDef[];
  relationTypes: PipelineRelationTypeDef[];
  /** Declared artifact types; absent entirely for a profile declaring none. */
  artifactTypes?: PipelineArtifactTypeDef[];
}

/** One entity type row on the wire: its declaration plus its two counts. */
export interface PipelineEntityTypeRow extends PipelineEntityTypeDef {
  /** VALID pages of this type — the `entityCounts` figure. */
  pageCount: number;
  /** The UNFILTERED per-state tally. Absent when no page of this type carries a state. */
  stateCounts?: Record<string, number>;
}

/** One relation type row on the wire: its declaration plus its live count. */
export interface PipelineRelationTypeRow extends PipelineRelationTypeDef {
  count: number;
}

/** The `profilePipeline` block `/api/pages` emits for a non-default profile. */
export interface PipelineEnvelope {
  entityTypes: PipelineEntityTypeRow[];
  /** Omitted entirely for a profile that declares no relation types. */
  relationTypes?: PipelineRelationTypeRow[];
  /**
   * Declared artifact types, carried through unchanged from the definitions —
   * there is no count to join onto them, since an artifact is reached through an
   * entity's `artifactRef` field rather than enumerated. Omitted entirely for a
   * profile that declares none.
   */
  artifactTypes?: PipelineArtifactTypeDef[];
}

/**
 * Project a loaded profile pack down to its pipeline DECLARATIONS.
 *
 * @param profile - The active non-default profile pack.
 * @returns The declared entity-type lifecycles and relation types, in
 *   declaration order (the order the profile lists them in, which is the order
 *   its author chose and the only one not invented here).
 */
export function buildPipelineDefinitions(profile: ProfilePack): PipelineDefinitions {
  const artifactTypes = Object.entries(profile.artifacts ?? {}).map(([type, def]) =>
    artifactTypeDefinition(type, def as ArtifactTypeDef),
  );
  return {
    entityTypes: Object.entries(profile.entities).map(([type, def]) =>
      entityTypeDefinition(type, def as EntityTypeDef),
    ),
    relationTypes: Object.entries(profile.relations ?? {}).map(([type, def]) =>
      relationTypeDefinition(type, def as RelationTypeDef),
    ),
    ...(artifactTypes.length > 0 ? { artifactTypes } : {}),
  };
}

/**
 * Every {@link FieldDef} facet that reaches the client, as an EXHAUSTIVE record.
 *
 * A `Record<ProjectedFieldFacet, true>` rather than an array: an array can be a
 * subset and compile, so a facet added to `FieldDef` would silently never be
 * projected. This shape fails to compile until the new facet is either listed
 * here or added to {@link DroppedFieldFacet} — the projection cannot lose a
 * field by omission, which is the same structural closure `directory` has.
 */
const PROJECTED_FIELD_FACETS: Record<ProjectedFieldFacet, true> = {
  type: true,
  required: true,
  enum: true,
  artifactTypes: true,
  format: true,
};

/**
 * Project one declared field: its name plus every projected facet it declares.
 *
 * Copies by facet list rather than by hand-written literal so
 * {@link PROJECTED_FIELD_FACETS} is the single place the boundary is stated. The
 * assembled object is cast once, at the end: TypeScript cannot see that iterating
 * the record's keys produces exactly `PipelineFieldDef`'s optional properties.
 */
function fieldDefinition(name: string, def: FieldDef): PipelineFieldDef {
  const projected: Record<string, unknown> = { name };
  for (const facet of Object.keys(PROJECTED_FIELD_FACETS) as ProjectedFieldFacet[]) {
    if (def[facet] !== undefined) projected[facet] = def[facet];
  }
  return projected as PipelineFieldDef;
}

/** Project a declared field map into the wire's ordered array, or `undefined` when empty. */
function fieldDefinitions(fields: Record<string, FieldDef> | undefined): PipelineFieldDef[] | undefined {
  const projected = Object.entries(fields ?? {}).map(([name, def]) => fieldDefinition(name, def));
  return projected.length > 0 ? projected : undefined;
}

/** Project one artifact type's declaration, omitting a metadata contract it does not declare. */
function artifactTypeDefinition(type: string, def: ArtifactTypeDef): PipelineArtifactTypeDef {
  const metadata = fieldDefinitions(def.metadata);
  return {
    type,
    fileName: def.fileName,
    contentKind: def.contentKind,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * The schema facets shared by both branches of {@link entityTypeDefinition} —
 * everything a type declares about its own records, as opposed to its lifecycle.
 */
function declaredSchema(def: EntityTypeDef): Partial<PipelineEntityTypeDef> {
  const fields = fieldDefinitions(def.fields);
  return {
    ...(def.titleField !== undefined ? { titleField: def.titleField } : {}),
    ...(fields ? { fields } : {}),
  };
}

/**
 * Read `key` off `record` only when the record OWNS it.
 *
 * Every lookup below indexes a plain object with a PROFILE-DECLARED name — an
 * entity type, a relation type, a lifecycle field. The profile schema puts no
 * `propertyNames` constraint on any of those name positions, so a bare index
 * resolves inherited members: a type named `constructor` reads
 * `Object.prototype.constructor`, which is a function, and then reads as a
 * truthy `stateCounts`, as a `count`/`pageCount` that `JSON.stringify` silently
 * drops from the row, or as an `enum` read off a function. Confining to own
 * properties makes each of those an honest "not declared" instead. Same guard
 * and same reasoning as `validateTitleField` (`src/profile/validate.ts`), which
 * hit this on `titleField`.
 *
 * @param record - The map to read, or `undefined`.
 * @param key - A profile-supplied name.
 * @returns The own value, or `undefined`.
 */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Project one entity type's declaration, omitting `lifecycle` when it declares none. */
function entityTypeDefinition(type: string, def: EntityTypeDef): PipelineEntityTypeDef {
  const base = { type, directory: def.directory, ...declaredSchema(def) };
  if (def.lifecycle === undefined) return base;
  const { field, initial, terminal, transitions } = def.lifecycle;
  const declared = own(def.fields, field)?.enum;
  return {
    ...base,
    lifecycle: {
      field,
      initial,
      terminal,
      transitions,
      ...(declared ? { declaredStates: declared } : {}),
    },
  };
}

/** Project one relation type's declaration: its endpoints and its direction. */
function relationTypeDefinition(type: string, def: RelationTypeDef): PipelineRelationTypeDef {
  return { type, from: def.from, to: def.to, direction: def.direction };
}

/**
 * Join the collected counts onto the declarations to produce the wire block.
 *
 * Returns `undefined` when there is nothing to project — a default project has
 * no declarations and no summary — so the caller omits the key entirely and a
 * default envelope stays byte-identical.
 *
 * @param definitions - The declarations from {@link buildPipelineDefinitions}.
 * @param summary - The active profile's summary block (counts and tallies).
 * @returns The `profilePipeline` block, or `undefined`.
 */
export function buildPipelineEnvelope(
  definitions: PipelineDefinitions | undefined,
  summary: ProfileSummaryBlock | undefined,
): PipelineEnvelope | undefined {
  if (!definitions || !summary) return undefined;
  const relationTypes = definitions.relationTypes.map((def) => ({
    ...def,
    count: own(summary.relationCounts, def.type) ?? 0,
  }));
  return {
    entityTypes: definitions.entityTypes.map((def) => entityTypeRow(def, summary)),
    ...(relationTypes.length > 0 ? { relationTypes } : {}),
    ...(definitions.artifactTypes ? { artifactTypes: definitions.artifactTypes } : {}),
  };
}

/**
 * Join one entity type's two counts onto its declaration. A type with no
 * enrolled page contributes no `entityCounts` key, which is a zero, not a gap —
 * but a type with no lifecycle TALLY genuinely has nothing to report, so that
 * key is omitted rather than sent as an empty object.
 */
function entityTypeRow(
  def: PipelineEntityTypeDef,
  summary: ProfileSummaryBlock,
): PipelineEntityTypeRow {
  const stateCounts = own(summary.lifecycleStates, def.type);
  return {
    ...def,
    pageCount: own(summary.entityCounts, def.type) ?? 0,
    ...(stateCounts ? { stateCounts } : {}),
  };
}
