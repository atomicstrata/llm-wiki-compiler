/**
 * @file test/preparations/lifecycle-model/coverage-types.ts
 * @description The closed dimensions of the finite lifecycle model.
 *
 * Sixteen review rounds each found a new unchecked cell of the same state space, so
 * the dimensions are enumerated here as closed arrays rather than left implicit. A new
 * operation, consumer, or state cannot be added without appearing in a dimension, and
 * the completeness assertion then demands coverage for it — which is the whole point:
 * the model must fail when it grows, not silently leave the new cell unproved.
 */

export const LIFECYCLE_OPERATIONS = ["quarantine", "reset", "prune", "sweep", "purge"] as const;

export const LIFECYCLE_REGISTRIES = ["quarantine", "prune"] as const;

export const LIFECYCLE_CONSUMERS = [
  "driver", "recovery", "status", "references", "gc", "capacity", "reset-planner", "sweep-resumer",
] as const;

export const LIFECYCLE_STATES = [
  "inert", "awaiting-continuation-intent-only", "awaiting-continuation-materialized",
  "planned", "applying", "completed", "historical", "unavailable",
] as const;

export const LIFECYCLE_PATH_LEVELS = [
  "llmwiki", "registry", "unit", "bytes-staging", "receipt", "object",
] as const;

export const LIFECYCLE_FILESYSTEM_STATES = [
  "absent", "regular", "empty-directory", "symlink", "non-directory", "unreadable", "redirected",
] as const;

export const LIFECYCLE_RECORD_STATES = [
  "absent", "valid-planned", "corrupt-planned", "copied-planned",
  "valid-completed", "corrupt-completed", "wrong-binding", "stale-epoch",
] as const;

export const LIFECYCLE_OBJECT_STATES = [
  "source-only", "destination-only", "both-same", "both-conflict", "neither", "unreadable",
] as const;

export const LIFECYCLE_CRASH_POINTS = [
  "before-plan", "after-plan", "during-object", "after-objects", "before-completion", "after-completion",
] as const;

/**
 * The ways a cell may RELAX protection. Every relaxation needs a negative case: the
 * recurring defect was evidence going missing and the system concluding "safe".
 */
export const LIFECYCLE_RELAXATIONS = [
  "none", "delete", "settle", "historical", "complete", "authorize",
] as const;

type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];
type LifecycleRegistry = (typeof LIFECYCLE_REGISTRIES)[number];
type LifecycleConsumer = (typeof LIFECYCLE_CONSUMERS)[number];
type LifecycleState = (typeof LIFECYCLE_STATES)[number];
type LifecyclePathLevel = (typeof LIFECYCLE_PATH_LEVELS)[number];
type LifecycleFilesystemState = (typeof LIFECYCLE_FILESYSTEM_STATES)[number];
type LifecycleRecordState = (typeof LIFECYCLE_RECORD_STATES)[number];
type LifecycleObjectState = (typeof LIFECYCLE_OBJECT_STATES)[number];
type LifecycleCrashPoint = (typeof LIFECYCLE_CRASH_POINTS)[number];
type LifecycleRelaxation = (typeof LIFECYCLE_RELAXATIONS)[number];

/** One modelled cell and the real test that proves it. */
export interface LifecycleCoverageRowV1 {
  readonly id: `PLA-CASE-${string}`;
  readonly operation: LifecycleOperation;
  readonly state: LifecycleState;
  readonly registry: LifecycleRegistry;
  readonly pathLevel: LifecyclePathLevel;
  readonly filesystemState: LifecycleFilesystemState;
  readonly recordState: LifecycleRecordState;
  readonly objectState: LifecycleObjectState;
  readonly crashPoint: LifecycleCrashPoint;
  readonly consumer: LifecycleConsumer;
  readonly protectionRelaxation: LifecycleRelaxation;
  readonly provingTestId: string;
  readonly frozenRegressionId?: `PLA-REG-${string}`;
}

/** Positional row builder; one modelled cell per line keeps the matrix reviewable. */
export function coverageRow(
  id: string,
  cell: readonly [
    LifecycleOperation, LifecycleState, LifecycleRegistry, LifecyclePathLevel,
    LifecycleFilesystemState, LifecycleRecordState, LifecycleObjectState,
    LifecycleCrashPoint, LifecycleConsumer, LifecycleRelaxation,
  ],
  provingTestId: string,
  frozenRegressionId?: string,
): LifecycleCoverageRowV1 {
  return {
    id: id as LifecycleCoverageRowV1["id"],
    operation: cell[0], state: cell[1], registry: cell[2], pathLevel: cell[3],
    filesystemState: cell[4], recordState: cell[5], objectState: cell[6],
    crashPoint: cell[7], consumer: cell[8], protectionRelaxation: cell[9],
    provingTestId,
    ...(frozenRegressionId === undefined
      ? {}
      : { frozenRegressionId: frozenRegressionId as `PLA-REG-${string}` }),
  };
}
