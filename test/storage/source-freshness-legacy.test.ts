/**
 * @file test/storage/source-freshness-legacy.test.ts
 * @description Source freshness through its ROOT function,
 * `buildFreshnessSnapshot`, on real files with nothing mocked. It states four
 * behaviours that no other test states, so that moving the source reads behind
 * a freshness-owned capability cannot change them. It is run byte for byte
 * against the source both before and after.
 *
 * What the other tests already pin, and this file does not repeat: a missing
 * sources directory, the decoded-text hash, a linked project root and a
 * directory source answered as not there (`residual-reads.test.ts`); a link
 * that escapes `sources/`, a traversal key and a named-pipe source
 * (`freshness.test.ts`).
 *
 * F4 is INCUMBENT, NOT ENDORSED: an absolute key is accepted when it lies
 * inside the sources root. It is pinned because it is what the code does today.
 *
 * Expected hashes are computed here with `node:crypto` from the literal text
 * written, never with a production helper. File names are not number-like, so
 * "the state's key order" is the order they were written in.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildFreshnessSnapshot } from "../../src/freshness/index.js";

let root = "";
const at = (relative: string): string => path.join(root, relative);
const NOT_THERE = { recordedHash: "RECORDED", currentHash: null, exists: false, concepts: ["topic"] };
/** What freshness answers for a source that is there and holds `text`. */
const hashed = (text: string) =>
  ({ recordedHash: "RECORDED", currentHash: createHash("sha256").update(text).digest("hex"), exists: true, concepts: ["topic"] });

/** Write a source under `sources/`, creating its directory. */
async function source(relative: string, text: string): Promise<void> {
  await mkdir(path.dirname(at(`sources/${relative}`)), { recursive: true });
  await writeFile(at(`sources/${relative}`), text);
}

/** Write a compile state that lists `keys`, in that order, each owning one concept. */
async function stateListing(...keys: string[]): Promise<void> {
  const sources = Object.fromEntries(keys.map((key) => [key, { hash: "RECORDED", concepts: ["topic"], compiledAt: "t" }]));
  await mkdir(at(".llmwiki"), { recursive: true });
  await writeFile(at(".llmwiki/state.json"), JSON.stringify({ version: 1, indexHash: "", sources }));
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-freshness-legacy-")));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("source freshness through its root function, as it behaves today", () => {
  it("F1 hashes a link inside sources/ that points at another file inside sources/", async () => {
    await source("real.md", "target text\n");
    await symlink(at("sources/real.md"), at("sources/alias.md"));
    await stateListing("alias.md");
    expect(await buildFreshnessSnapshot(root)).toEqual({ stateStatus: "ok", sources: { "alias.md": hashed("target text\n") } });
  });

  it("F2 hashes a nested source and answers not-there for a dangling link", async () => {
    await source("deep/inner.md", "inner\n");
    await symlink(at("sources/nowhere.md"), at("sources/dangling.md"));
    await stateListing("deep/inner.md", "dangling.md");
    expect((await buildFreshnessSnapshot(root)).sources).toEqual({ "deep/inner.md": hashed("inner\n"), "dangling.md": NOT_THERE });
  });

  it("F3 keeps the state's key order, which is not sorted", async () => {
    await source("zeta.md", "z");
    await source("alpha.md", "a");
    await source("mid/beta.md", "b");
    await stateListing("zeta.md", "gone.md", "alpha.md", "mid/beta.md");
    const { sources } = await buildFreshnessSnapshot(root);
    expect(Object.keys(sources)).toEqual(["zeta.md", "gone.md", "alpha.md", "mid/beta.md"]);
    expect(Object.values(sources)).toEqual([hashed("z"), NOT_THERE, hashed("a"), hashed("b")]);
  });

  it("F4 INCUMBENT, NOT ENDORSED: hashes an absolute key inside the sources root and refuses one outside it", async () => {
    await source("abs.md", "absolute\n");
    await writeFile(at("outside.md"), "outside the sources root\n");
    await stateListing(at("sources/abs.md"), at("outside.md"));
    expect((await buildFreshnessSnapshot(root)).sources).toEqual({
      [at("sources/abs.md")]: hashed("absolute\n"), [at("outside.md")]: NOT_THERE,
    });
  });
});
