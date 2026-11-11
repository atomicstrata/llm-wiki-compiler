/**
 * @file src/compiler/derived-steps.ts
 * @description What compile's derived steps (entity pages, the timeline) share
 * over a local project: the compiled sources from the state file, source reads,
 * compile's locked page writer, model provenance and the clock; and the split of
 * a write batch into the writes that landed and those the write floor skipped.
 *
 * PRECONDITION: the caller holds the project lock (compile does), because the
 * writes go through the lock-free executor core.
 */

import path from "path";
import { readState } from "../utils/state.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { applyCompilePageWritesLocked, type CompilePageWrite, type SkippedWrite } from "./compile-write.js";
import { addModelProvenanceMeta } from "./provenance.js";

/** The reads and writes every derived step composes. */
export interface DerivedSteps {
  /** Every compiled source with its content hash. */
  listSources(): Promise<{ file: string; hash: string }[]>;
  /** A source's whole text. */
  readSource(file: string): Promise<string>;
  /** Apply the writes as one batch under compile's held lock. */
  writePages(writes: CompilePageWrite[]): Promise<{ skipped: SkippedWrite[] }>;
  /** Provenance stamped into each page's frontmatter (model, prompt version). */
  provenance(): Record<string, unknown>;
  /** The current time, as an ISO string. */
  now(): string;
}

/** The derived steps over the local project at `root`. */
export function localDerivedSteps(root: string): DerivedSteps {
  const reads = diskLocalReads(root);
  return {
    listSources: async () => Object.entries((await readState(root)).sources).map(([file, state]) => ({ file, hash: state.hash })),
    readSource: (file) => reads.readText(path.join(SOURCES_DIR, file)),
    writePages: (writes) => applyCompilePageWritesLocked(root, writes),
    provenance: () => {
      const fields: Record<string, unknown> = {};
      addModelProvenanceMeta(fields);
      return fields;
    },
    now: () => new Date().toISOString(),
  };
}

/** Apply `writes` and split them into those that landed and those the write floor skipped. */
export async function applyWrites<T extends CompilePageWrite>(steps: Pick<DerivedSteps, "writePages">, writes: T[]): Promise<{ landed: T[]; blocked: T[] }> {
  if (writes.length === 0) return { landed: [], blocked: [] };
  const { skipped } = await steps.writePages(writes);
  const blockedSlugs = new Set(skipped.map((skip) => skip.item.slug));
  return { landed: writes.filter((write) => !blockedSlugs.has(write.slug)), blocked: writes.filter((write) => blockedSlugs.has(write.slug)) };
}
