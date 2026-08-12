/**
 * Unit tests for `src/viewer/shell.ts` — template loading and in-memory caching.
 * The HTTP integration of these helpers is exercised by
 * `test/viewer-server.test.ts`; this file owns the missing-template and
 * cache-hit edges that are awkward to reach through subprocess fetches.
 *
 * The module used to substitute a `<!--PAGE_INDEX-->` marker with an escaped
 * page-list blob, and the escape contract was tested here. Both are gone: the
 * Nebula sidebar paints from an empty model and fills from `/api/pages`, so
 * nothing read the blob. What remains is a template served verbatim, which is
 * asserted below — a shell that grew a per-request substitution again would be
 * a second, drift-prone copy of the page list on the wire.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rm, writeFile } from "fs/promises";
import path from "path";
import { loadShellTemplate, resetShellTemplateCache } from "../src/viewer/shell.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";

const TEMPLATE_SHELL = `<html><body><main data-main-pane></main></body></html>`;

// `makeOutsideDir` returns a fresh tmp directory; we reuse it here so the
// shell-template tests share temp-dir wiring with the symlink-escape tests.
const makeAssetsDir = makeOutsideDir;

beforeEach(() => {
  resetShellTemplateCache();
});

describe("loadShellTemplate", () => {
  it("returns the file contents when index.html is present", async () => {
    const dir = await makeAssetsDir();
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const result = await loadShellTemplate(dir);
    expect(result).toBe(TEMPLATE_SHELL);
  });

  it("returns the template byte-for-byte, substituting nothing", async () => {
    const dir = await makeAssetsDir();
    const withMarkerLikeText = `${TEMPLATE_SHELL}<!--PAGE_INDEX-->`;
    await writeFile(path.join(dir, "index.html"), withMarkerLikeText);
    expect(await loadShellTemplate(dir)).toBe(withMarkerLikeText);
  });

  it("returns null when index.html is missing on disk", async () => {
    const dir = await makeAssetsDir();
    const result = await loadShellTemplate(dir);
    expect(result).toBeNull();
  });

  it("serves cached bytes after the file is deleted (in-memory cache)", async () => {
    const dir = await makeAssetsDir();
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const first = await loadShellTemplate(dir);
    await rm(path.join(dir, "index.html"));
    const second = await loadShellTemplate(dir);
    expect(first).toBe(TEMPLATE_SHELL);
    expect(second).toBe(TEMPLATE_SHELL);
  });

  it("caches the missing-template result so the disk is not hammered", async () => {
    const dir = await makeAssetsDir();
    const first = await loadShellTemplate(dir);
    // Create the file AFTER the first miss — the cache should still report null.
    await writeFile(path.join(dir, "index.html"), TEMPLATE_SHELL);
    const second = await loadShellTemplate(dir);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
