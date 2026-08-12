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
import type { EntityTypeDef, ProfilePack, RelationTypeDef } from "../profile/types.js";

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
  return {
    entityTypes: Object.entries(profile.entities).map(([type, def]) =>
      entityTypeDefinition(type, def as EntityTypeDef),
    ),
    relationTypes: Object.entries(profile.relations ?? {}).map(([type, def]) =>
      relationTypeDefinition(type, def as RelationTypeDef),
    ),
  };
}

/** Project one entity type's declaration, omitting `lifecycle` when it declares none. */
function entityTypeDefinition(type: string, def: EntityTypeDef): PipelineEntityTypeDef {
  if (def.lifecycle === undefined) return { type, directory: def.directory };
  const { field, initial, terminal, transitions } = def.lifecycle;
  const declared = def.fields?.[field]?.enum;
  return {
    type,
    directory: def.directory,
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
    count: summary.relationCounts?.[def.type] ?? 0,
  }));
  return {
    entityTypes: definitions.entityTypes.map((def) => entityTypeRow(def, summary)),
    ...(relationTypes.length > 0 ? { relationTypes } : {}),
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
  const stateCounts = summary.lifecycleStates?.[def.type];
  return {
    ...def,
    pageCount: summary.entityCounts[def.type] ?? 0,
    ...(stateCounts ? { stateCounts } : {}),
  };
}
