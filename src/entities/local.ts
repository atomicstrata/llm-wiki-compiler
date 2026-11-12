/**
 * @file src/entities/local.ts
 * @description The entity step over a local project: the effective profile's
 * opted-in types, compiled sources from the state file, the extraction cache at
 * `.llmwiki/entities.json`, the owner's alias registry at `.llmwiki/aliases.json`,
 * the configured model, and compile's locked page writer.
 *
 * Also the read the timeline uses for each day's "People this day": the records
 * of a type whose page exists, with the source lines they are mentioned on.
 *
 * PRECONDITION: the caller holds the project lock (compile does), because the
 * writes go through the lock-free executor core.
 */

import path from "path";
import { readFile } from "fs/promises";
import { callClaude } from "../utils/llm.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { LLMWIKI_DIR } from "../utils/constants.js";
import { localDerivedSteps, ownPages } from "../compiler/derived-steps.js";
import { resolveCompileConcurrency } from "../compiler/concurrency.js";
import { loadProfile } from "../profile/load.js";
import * as output from "../utils/output.js";
import type { TimelineSchema } from "../schema/types.js";
import type { PersonMentions } from "../timeline/pages.js";
import { mentionsOf, type ExtractionCache } from "./extract.js";
import { extractableTypes } from "./schema.js";
import { displayName, parseRegistry, resolveRecords } from "./identity.js";
import { generateEntitiesWith, type EntityResult, type EntitySteps } from "./generate.js";
import { isRecordPage } from "./pages.js";

/** The extraction cache, relative to the project root. */
const CACHE_FILE = path.join(LLMWIKI_DIR, "entities.json");
/** The owner's alias registry, relative to the project root. */
const REGISTRY_FILE = path.join(LLMWIKI_DIR, "aliases.json");

/** A file's text, or null when it does not exist. */
async function readOptional(root: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relPath), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The extraction cache, or null when there is none or it cannot be read as one. */
async function readCache(root: string): Promise<ExtractionCache | null> {
  const text = await readOptional(root, CACHE_FILE);
  if (text === null) return null;
  try {
    const cache = JSON.parse(text) as ExtractionCache;
    const isCache = typeof cache?.digest === "string" && cache.sources !== null && typeof cache.sources === "object"
      && Object.values(cache.sources).every((entry) => typeof entry?.hash === "string" && Array.isArray(entry.chunks));
    return isCache ? cache : null;
  } catch {
    return null;
  }
}

/** The registry; a malformed one throws, naming the file, so a typo is not silently ignored. */
async function readRegistry(root: string): ReturnType<EntitySteps["readRegistry"]> {
  try {
    return parseRegistry(await readOptional(root, REGISTRY_FILE));
  } catch (error) {
    throw new Error(`${REGISTRY_FILE} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The entity steps over the local project at `root`. */
function localEntitySteps(root: string): EntitySteps {
  return {
    ...localDerivedSteps(root),
    readCache: () => readCache(root),
    writeCache: (cache) => atomicWrite(path.join(root, CACHE_FILE), `${JSON.stringify(cache)}\n`),
    readRegistry: () => readRegistry(root),
    complete: (request) => callClaude(request),
  };
}

/**
 * Bring every opted-in entity type's pages up to date and report what changed.
 * @param root - Project root; the caller holds its lock.
 * @param timeline - The schema's timeline settings, for each page's Days list.
 * @param concurrency - The compile's `--concurrency`, if given; otherwise the env var or the default.
 */
export async function generateEntities(root: string, timeline: TimelineSchema, concurrency?: number): Promise<EntityResult> {
  const types = extractableTypes((await loadProfile(root)).profile);
  if (types.length === 0) return { extracted: 0, written: [], deleted: [], errors: [] };
  output.status("👤", output.info(`Updating ${types.map(({ type }) => type).join(", ")} pages...`));
  const result = await generateEntitiesWith(localEntitySteps(root), {
    types, timeZone: timeline.enabled ? timeline.timeZone : null, concurrency: resolveCompileConcurrency(concurrency),
  });
  for (const error of result.errors) output.status("!", output.warn(error));
  if (result.extracted + result.written.length + result.deleted.length > 0) {
    output.status("✓", output.success(`Entities: ${result.extracted} sources read, ${result.written.length} pages written, ${result.deleted.length} removed.`));
  }
  return result;
}

/** The records of `type` whose page this step wrote, with every source line they are mentioned on. */
export async function listRecordMentions(root: string, type: string): Promise<PersonMentions[]> {
  const cache = await readCache(root);
  if (!cache) return [];
  const registry = await readRegistry(root);
  const { own } = ownPages(await localDerivedSteps(root).listPages(type), isRecordPage);
  return resolveRecords(type, mentionsOf(cache, type), registry)
    .filter((record) => own.has(record.id))
    .map((record) => ({
      target: `${type}/${record.id}`,
      title: displayName(record, registry.entities[type]?.[record.id]),
      spans: record.mentions.flatMap((mention) => mention.lines.map((lines) => ({ file: mention.file, lines }))),
    }));
}
