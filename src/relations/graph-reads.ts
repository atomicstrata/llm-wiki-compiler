/**
 * @file src/relations/graph-reads.ts
 * @description The relation store's graph read: the shared confined
 * graph-store read (`../utils/jsonl-store.ts`) plus the OPTIONAL segmented
 * relation log a `local-indexed` project dispatches every relation body to.
 * The dispatch lives here, at the relation layer, rather than in the shared
 * graph-store mechanism (which the event store also uses), so the segmented
 * log, which appends events, never sits below the event store.
 *
 * Every production caller that hands a graph to a relation reader or writer
 * builds it with {@link diskRelationGraphReads}; a graph without the member
 * (a test double) runs the single-file bodies.
 */

import type { SegmentedRelationLog } from "../history/relations-read.js";
import { diskGraphStoreReads, type GraphStoreReads } from "../utils/jsonl-store.js";

/** A graph-store read that can also name the segmented relation log. */
export interface RelationGraphReads extends GraphStoreReads {
  /**
   * OPTIONAL: the segmented relation log when the project is `local-indexed`
   * (the relation bodies then dispatch to it), or `null` when the incumbent
   * `relations.jsonl` is the authority. Absent in test doubles.
   */
  segmentedRelations?(): Promise<SegmentedRelationLog | null>;
}

/** LOCAL DISK. The relation graph read for the project at `root`. Building it does no I/O. In no package index. */
export function diskRelationGraphReads(root: string): RelationGraphReads {
  return {
    ...diskGraphStoreReads(root),
    // Loaded on demand; the segmented log imports only the relation leaves (./record-check.ts, ./relation-build.ts).
    segmentedRelations: () => import("../history/relations-read.js").then((log) => log.segmentedRelationLogFor(root)),
  };
}
