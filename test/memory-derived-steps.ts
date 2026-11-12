/**
 * @file test/memory-derived-steps.ts
 * @description In-memory {@link DerivedSteps} the timeline and entity tests build
 * on: sources from a record, pages in one map keyed `<directory>/<slug>`, and
 * every write batch recorded.
 */

import { compileWriteDirectory, type CompilePageWrite } from "../src/compiler/compile-write.js";
import type { DerivedSteps } from "../src/compiler/derived-steps.js";

/** The steps over `sources` (filename → text; edit it to change a source), with their pages and write batches. */
export function memoryDerivedSteps(sources: Record<string, string>) {
  const pages = new Map<string, string>();
  const batches: CompilePageWrite[][] = [];
  const steps: DerivedSteps = {
    listSources: async () => Object.entries(sources).map(([file, text]) => ({ file, hash: `h:${text}` })),
    readSource: async (file) => sources[file],
    listPages: async (directory) => new Map([...pages].filter(([key]) => key.startsWith(`${directory}/`)).map(([key, text]) => [key.slice(directory.length + 1), text])),
    writePages: async (writes) => {
      batches.push(writes);
      for (const write of writes) {
        const key = `${compileWriteDirectory(write)}/${write.slug}`;
        if (write.deleting) pages.delete(key); else pages.set(key, write.body);
      }
      return { skipped: [] };
    },
    provenance: () => ({ modelId: "test-model" }),
    now: () => "2026-05-10T00:00:00.000Z",
  };
  return { steps, pages, batches };
}
