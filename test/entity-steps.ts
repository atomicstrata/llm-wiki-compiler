/**
 * @file test/entity-steps.ts
 * @description Shared fixtures for the entity tests: a profile with an opted-in
 * `person` type, and in-memory {@link EntitySteps} that answer extraction and
 * page requests deterministically and record every request and write.
 */

import type { ProfilePack } from "../src/profile/types.js";
import type { EntityConfig, EntitySteps } from "../src/entities/generate.js";
import { extractableTypes } from "../src/entities/schema.js";
import { memoryDerivedSteps } from "./memory-derived-steps.js";
import type { ExtractionCache, ExtractRequest } from "../src/entities/extract.js";
import type { AliasRegistry, Mention } from "../src/entities/identity.js";

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
  const base = memoryDerivedSteps(sources);
  const extractions: string[] = [];
  const pageRequests: string[] = [];
  const state = { cache: null as ExtractionCache | null, registry };
  const steps: EntitySteps = {
    ...base.steps,
    readCache: async () => state.cache,
    writeCache: async (cache) => { state.cache = structuredClone(cache); },
    readRegistry: async () => state.registry,
    complete: async (request: ExtractRequest) => answer(request, people, extractions, pageRequests),
  };
  return { steps, pages: base.pages, batches: base.batches, extractions, pageRequests, state };
}

/** The step's config for `profile` (default: {@link personProfile}) and the timeline's zone (`null`: timeline off). */
export function entityConfig(options: { profile?: ProfilePack; timeZone?: string | null } = {}): EntityConfig {
  return { types: extractableTypes(options.profile ?? personProfile()), timeZone: options.timeZone === undefined ? "UTC" : options.timeZone, concurrency: 2 };
}

/** A mention of `name` in `file` at `line`. */
export function mention(name: string, file = "chat.md", line = 1): Mention {
  return { file, name, fields: {}, lines: [{ start: line, end: line }] };
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
