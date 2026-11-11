/**
 * @file test/entity-steps.ts
 * @description Shared fixtures for the entity tests: a profile with an opted-in
 * `person` type, and in-memory {@link EntitySteps} that answer extraction and
 * page requests deterministically and record every request and write.
 */

import type { ProfilePack } from "../src/profile/types.js";
import type { CompilePageWrite } from "../src/compiler/compile-write.js";
import type { EntitySteps } from "../src/entities/generate.js";
import type { ExtractionCache, ExtractRequest } from "../src/entities/extract.js";
import type { AliasRegistry } from "../src/entities/identity.js";

/** A profile with a `person` type that opts in, and a `project` type that does not. */
export function personProfile(description = "A person the owner knows"): ProfilePack {
  return {
    entities: {
      person: {
        directory: "wiki/person", titleField: "title", extract: { description, fields: { relationship: "How the owner knows them" } },
        fields: {
          title: { type: "string" }, relationship: { type: "enum", enum: ["friend", "family", "unknown"] },
          aliases: { type: "string[]" }, organization: { type: "string" },
        },
      },
      project: { directory: "wiki/project", fields: { title: { type: "string" } } },
    },
  } as unknown as ProfilePack;
}

/** An extracted person, as the fake model reports one: who, how the source wrote them (default: the name), and where. */
export interface FakePerson { name: string; writtenAs?: string[]; relationship?: string; line: number }

/** In-memory steps over `sources`; `people` says who each source names. */
export function memoryEntitySteps(sources: Record<string, string>, people: Record<string, FakePerson[]>, registry: AliasRegistry = { entities: {} }) {
  const pages = new Map<string, string>();
  const extractions: string[] = [];
  const pageRequests: string[] = [];
  const batches: CompilePageWrite[][] = [];
  const state = { cache: null as ExtractionCache | null, registry };
  const steps: EntitySteps = {
    listSources: async () => Object.entries(sources).map(([file, text]) => ({ file, hash: `h:${text}` })),
    readSource: async (file) => sources[file],
    readCache: async () => state.cache,
    writeCache: async (cache) => { state.cache = structuredClone(cache); },
    readRegistry: async () => state.registry,
    listPages: async (type) => new Map([...pages].filter(([key]) => key.startsWith(`${type}/`)).map(([key, text]) => [key.slice(type.length + 1), text])),
    complete: async (request: ExtractRequest) => answer(request, people, extractions, pageRequests),
    writePages: async (writes) => {
      batches.push(writes);
      for (const write of writes) {
        const key = `${write.entityType}/${write.slug}`;
        if (write.deleting) pages.delete(key); else pages.set(key, write.body);
      }
      return { skipped: [] };
    },
    provenance: () => ({ modelId: "test-model" }),
    now: () => "2026-05-10T00:00:00.000Z",
  };
  return { steps, pages, extractions, pageRequests, batches, state };
}

/** The fake model: extraction answers from `people`; a page answer cites the first line shown. */
function answer(request: ExtractRequest, people: Record<string, FakePerson[]>, extractions: string[], pageRequests: string[]): string {
  const content = request.messages[0].content;
  if (request.tools.length > 0) {
    const file = /--- SOURCE: (\S+) ---/.exec(content)![1];
    extractions.push(file);
    return JSON.stringify({ person: (people[file] ?? []).map((person) => ({
      name: person.name, writtenAs: person.writtenAs ?? [person.name], relationship: person.relationship ?? null, aliases: [], organization: null, lines: [{ start: person.line, end: person.line }],
    })) });
  }
  const name = /Records that mention (.+):/.exec(content)![1];
  pageRequests.push(name);
  const [, file, line] = /--- SOURCE: (\S+) ---\n\n\s*(\d+) \|/.exec(content)!;
  return `SUMMARY: ${name} is someone the owner knows.\n## Notes\n\n- Mentioned. ^[${file}:${line}-${line}]`;
}
