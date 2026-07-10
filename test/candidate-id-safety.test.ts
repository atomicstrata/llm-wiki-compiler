/**
 * @file test/candidate-id-safety.test.ts
 * @description Path-traversal hardening for candidate ids/slugs (FIX #2).
 *
 * `writeCandidate` builds a candidate id as `${slug}-${hex}` and the path
 * helpers join that id straight into `.llmwiki/candidates/`. A traversal-bearing
 * slug (`../evil`) would make the id a path-escape string. These tests pin that:
 *  - `writeCandidate` REFUSES an unsafe slug (typed error, nothing written);
 *  - a normal safe candidate still round-trips identically (byte-for-byte body);
 *  - no file is ever written outside the candidates dir.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import {
  writeCandidate,
  readCandidate,
  UnsafeCandidateIdError,
} from "../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const BODY = "---\ntitle: Safe\n---\n\nBody.\n";

/** A safe candidate draft for `slug` with a fixed body. */
function draftFor(slug: string) {
  return { title: slug, slug, summary: "", sources: [], body: BODY };
}

describe("candidate id/slug path-traversal safety", () => {
  it("refuses an unsafe traversal slug and writes nothing", async () => {
    await expect(writeCandidate(root.dir, draftFor("../evil"))).rejects.toBeInstanceOf(
      UnsafeCandidateIdError,
    );
    const dir = path.join(root.dir, CANDIDATES_DIR);
    const files = existsSync(dir) ? await readdir(dir) : [];
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("refuses a slug containing a path separator and writes nothing", async () => {
    await expect(writeCandidate(root.dir, draftFor("nested/evil"))).rejects.toBeInstanceOf(
      UnsafeCandidateIdError,
    );
    expect(existsSync(path.join(root.dir, "nested"))).toBe(false);
  });

  it("does not escape the candidates dir for a deep traversal slug", async () => {
    await expect(
      writeCandidate(root.dir, draftFor("../../outside")),
    ).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    expect(existsSync(path.join(path.dirname(root.dir), "outside.json"))).toBe(false);
  });

  it("round-trips a normal safe candidate identically", async () => {
    const created = await writeCandidate(root.dir, draftFor("attention-rag"));
    expect(created.id).toMatch(/^attention-rag-[0-9a-f]{8}$/);
    const loaded = await readCandidate(root.dir, created.id);
    expect(loaded?.body).toBe(BODY);
    const file = path.join(root.dir, CANDIDATES_DIR, `${created.id}.json`);
    expect(JSON.parse(await readFile(file, "utf8")).slug).toBe("attention-rag");
  });
});
