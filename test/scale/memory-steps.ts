/**
 * @file test/scale/memory-steps.ts
 * @description The root-free scale transition steps over an in-memory record,
 * shared by the transition and scale-down record tests: a record text with a
 * write counter, a logged fake lock, a stated free space and an absent
 * embedding store (so the container step finds nothing to convert).
 */

import { ScaleRefusalError } from "../../src/scale/contracts.js";
import type { ScaleTransitionSteps } from "../../src/scale/transition.js";

/** An in-memory project: its record text, write count, lock log and free space. */
export interface Memory { text: string | null; writes: number; log: string[]; free: number }

/** Steps over `memory`; the embedding store is absent, so the container step finds nothing to convert. */
export function memorySteps(memory: Memory): ScaleTransitionSteps {
  return {
    acquire: async () => { memory.log.push("acquire"); },
    release: async () => { memory.log.push("release"); },
    record: {
      resolvePrivateDir: async () => (memory.text === null ? null : "/mem"),
      readLeaf: async () => (memory.text === null ? { kind: "absent" } : { kind: "ok", body: memory.text }),
      createPrivateDir: async () => {},
      replaceLeaf: async (_relPath, content) => { memory.text = content; memory.writes += 1; },
    },
    preflight: { freeBytes: async () => memory.free },
    container: { reads: { resolvePrivateDir: async () => null, leafKind: async () => "absent", readLeafBytes: async () => null }, replaceBinary: async () => {} },
  };
}

/** The refusal code a promise rejects with (`resolved` when it does not). */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "resolved", (error) => (error instanceof ScaleRefusalError ? error.code : String(error)));
}
