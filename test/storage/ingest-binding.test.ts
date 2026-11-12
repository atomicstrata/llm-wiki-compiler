/**
 * @file test/storage/ingest-binding.test.ts
 * @description The two ingest entries as ONE body each over their two project
 * steps, `ingestSourceWith` and `ingestTextSourceWith`, with no project
 * directory. This file uses them, which exist only after ingest was given steps
 * of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. The disk side ingests on a real temporary project: a text
 * created, re-ingested unchanged, then updated, and a local Markdown FILE (the
 * operator-named host input, kept outside the project). The memory side runs
 * the same asks through the bodies, saving with the REAL `saveSourceWith` over
 * an in-memory sources directory and recording each journal request; the
 * results and the journal decisions must equal the disk's.
 *
 * THE ROOT ROUTE IS UNCHANGED. The gated save and the journal append are spied:
 * the bound route reaches neither, and the root route reaches each with its
 * exact arguments.
 *
 * NOT SHOWN HERE: the registered-project lock, the writer's confinement and
 * collision rules, the journal's text and the remote fetchers; the ingest,
 * source-writer and activity-log suites show those. The doubles are not a
 * hosted store, not an access-control layer and not `ProjectStore`.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import {
  ingestSource, ingestSourceWith, ingestTextSource, ingestTextSourceWith, type IngestProjectSteps,
} from "../../src/commands/ingest.js";
import * as registeredProjectLock from "../../src/operation-bundles/registered-project-lock.js";
import * as activityLog from "../../src/utils/activity-log.js";
import { LOG_FILE } from "../../src/utils/constants.js";
import { saveSourceWith, type SourceWriterLeaves } from "../../src/utils/source-writer.js";
import { tempRootTracker } from "../temp-roots.js";

const PREFIX = "ingest-binding-";
const BODY = "A source body long enough to pass the minimum content check for ingest.";
/** The text asks, in order: created, re-ingested unchanged, then updated under the same identity. */
const ASKS = [
  { title: "Field Notes", text: BODY, source: "notes:1" },
  { title: "Field Notes", text: BODY, source: "notes:1" },
  { title: "Field Notes", text: `${BODY} Revised.`, source: "notes:1" },
];

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** An in-memory sources directory `S` over `files` (name → text). */
function memoryWriter(files: Map<string, string>): SourceWriterLeaves {
  return {
    openSourcesDir: async () => "S",
    listIdentityNames: async () => [...files.keys()],
    regularFile: async (_dir, name) => (files.has(name) ? `S/${name}` : null),
    readText: async (file) => files.get(file.slice(2))!,
    entryPresent: async (_dir, name) => files.has(name),
    createExclusive: async (_dir, name, text) => {
      if (files.has(name)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      files.set(name, text);
    },
    entryKind: async () => "file",
    overwrite: async (_dir, name, text) => { files.set(name, text); },
  };
}

/** The bound steps over one memory directory; each journal request is recorded as `title|source|charCount`. */
function memorySteps(journaled: string[]): IngestProjectSteps {
  const files = new Map<string, string>();
  return {
    save: (title, document, source) => saveSourceWith(memoryWriter(files), title, document, source),
    journal: async (title, source, _savedPath, charCount) => { journaled.push(`${title}|${source}|${charCount}`); },
  };
}

/** How many ingest entry headings (`## [<at>] ingest | …`) the project's activity log holds. */
const loggedIngests = async (root: string): Promise<number> =>
  ((await readFile(path.join(root, LOG_FILE), "utf-8").catch(() => "")).match(/^## \[[^\]]+\] ingest \| /gmu) ?? []).length;

describe("ingest over its two project steps, with no project directory", () => {
  it("I1 creates, keeps an unchanged re-ingest unjournaled, then updates, exactly as the disk did", async () => {
    const root = await tracker.create(PREFIX);
    const onDisk = [];
    for (const ask of ASKS) onDisk.push(await ingestTextSource(root, ask));
    const journaled: string[] = [];
    const steps = memorySteps(journaled);
    const inMemory = [];
    for (const ask of ASKS) inMemory.push(await ingestTextSourceWith(steps, ask));
    expect(inMemory).toEqual(onDisk);
    expect(onDisk.map((result) => result.writeStatus)).toEqual(["created", "unchanged", "updated"]);
    expect([journaled.length, await loggedIngests(root)]).toEqual([2, 2]);
  });

  it("I2 ingests a local file through the same body as the disk did, journaling the one real write", async () => {
    const [root, outside] = [await tracker.create(PREFIX), await tracker.create(PREFIX)];
    const file = path.join(outside, "harbor-survey.md");
    await writeFile(file, `# Harbor Survey\n\n${BODY}\n`);
    const onDisk = await ingestSource(root, file);
    const journaled: string[] = [];
    expect(await ingestSourceWith(memorySteps(journaled), file)).toEqual(onDisk);
    expect([onDisk.sourceType, onDisk.writeStatus, journaled.length]).toEqual(["file", "created", 1]);
    expect(journaled[0]!.endsWith(`|${file}|${onDisk.charCount}`)).toBe(true);
  });

  it("I3 refuses blank text before any step, saves short text (a warning, not a refusal), and journals no unsluggable title", async () => {
    const journaled: string[] = [], saves: string[] = [];
    const steps = memorySteps(journaled);
    const counted: IngestProjectSteps = { ...steps, save: (title, document, source) => { saves.push(title); return steps.save(title, document, source); } };
    await expect(ingestTextSourceWith(counted, { title: "Blank", text: "  \n " })).rejects.toThrow("No readable content could be extracted from the source.");
    expect(saves).toEqual([]);
    expect((await ingestTextSourceWith(counted, { title: "Short", text: "tiny" })).writeStatus).toBe("created");
    await expect(ingestTextSourceWith(counted, { title: "🙂", text: BODY })).rejects.toThrow("Could not derive a filename");
    expect(saves).toEqual(["Short", "🙂"]);
    expect(journaled.map((entry) => entry.split("|")[0])).toEqual(["Short"]);
  });

  it("I4 reaches no root step from the bound route, while the root route reaches each with its exact arguments", async () => {
    const save = vi.spyOn(registeredProjectLock, "saveSourceUnderProjectGate");
    const log = vi.spyOn(activityLog, "appendLog");
    await ingestTextSourceWith(memorySteps([]), ASKS[0]!);
    expect([save.mock.calls.length, log.mock.calls.length]).toEqual([0, 0]);
    const root = await tracker.create(PREFIX);
    await ingestTextSource(root, ASKS[0]!);
    expect(save.mock.calls).toEqual([[root, "Field Notes", expect.any(String), "notes:1"]]);
    expect(log.mock.calls).toEqual([[root, "ingest", "Field Notes", expect.objectContaining({ details: expect.any(Array) })]]);
  });
});
