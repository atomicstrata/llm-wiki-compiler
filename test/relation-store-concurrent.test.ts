/**
 * @file test/relation-store-concurrent.test.ts
 * @description PROCESS-LEVEL concurrent-writer test for the append-only relation
 * store (spec 08 requires a real cross-process test for JSONL stores; FIX #13).
 *
 * APPROACH: spawn N SEPARATE `node` subprocesses, each importing the PUBLIC SDK
 * (`createWiki().createRelation`) from the BUILT `dist/index.js` (built once by
 * the vitest global setup) and appending K relations with DISTINCT endpoint
 * slugs (so content hashes differ and dedup never collapses them) against the
 * SAME project root, all at once. Because `createRelation` takes the project lock
 * with a BLOCKING acquire (prior commit 90b6952), the concurrent writers must
 * SERIALIZE rather than interleave.
 *
 * The verification reuses `readRelations`, which checksum-verifies every line and
 * FAILS CLOSED on any torn/interior record. So a green read with zero problems is
 * itself proof that no line was torn or interleaved; we additionally assert the
 * total equals N*K (none lost, none torn) and the header appears exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RELATIONS_FILE } from "../src/utils/constants.js";
import { readRelations } from "../src/relations/store-read.js";

const exec = promisify(execFile);

/** Absolute path to the BUILT public SDK bundle (built once by global setup). */
const DIST_INDEX = path.resolve("dist/index.js");

/** The two-entity, one-`tests`-relation profile each subprocess writes against. */
const PROFILE = {
  schemaVersion: 1,
  profileId: "research",
  entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
  relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
};

const WRITERS = 3;
const APPENDS_PER_WRITER = 8;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-concurrent-"));
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify(PROFILE), "utf8");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/**
 * Inline ESM worker source: append `APPENDS_PER_WRITER` `tests` relations whose
 * `to` slug is `ideas/w<writer>-r<i>` — distinct per (writer, append) so no two
 * collapse under content-hash dedup.
 *
 * @param writer - The writer index, namespacing this process's endpoint slugs.
 * @returns A self-contained ESM script string to pass to `node -e`.
 */
function workerScript(writer: number): string {
  return `import { createWiki } from ${JSON.stringify(DIST_INDEX)};
const wiki = createWiki({ root: ${JSON.stringify(root)} });
for (let i = 0; i < ${APPENDS_PER_WRITER}; i++) {
  await wiki.createRelation({ type: "tests", from: "experiments/a", to: "ideas/w${writer}-r" + i });
}`;
}

/** Spawn one writer subprocess (separate node process), resolving on clean exit. */
function spawnWriter(writer: number): Promise<void> {
  return exec("node", ["--input-type=module", "-e", workerScript(writer)]).then(() => undefined);
}

describe("relation store — concurrent writers (subprocess, spec 08)", () => {
  it("serializes N processes' appends with no torn, lost, or interleaved records", async () => {
    await Promise.all(Array.from({ length: WRITERS }, (_unused, w) => spawnWriter(w)));

    const { relations, problems } = await readRelations(root);
    expect(problems).toEqual([]); // checksum-verified read: any tear would surface here
    expect(relations).toHaveLength(WRITERS * APPENDS_PER_WRITER);

    const raw = await readFile(path.join(root, RELATIONS_FILE), "utf8");
    const headers = raw.split("\n").filter((line) => line.includes("relation-store-header"));
    expect(headers).toHaveLength(1);
  }, 60_000);
});
