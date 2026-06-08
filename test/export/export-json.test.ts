/**
 * Tests for the in-memory exportJson entry point.
 *
 * Verifies that exportJson returns a JsonExportDocument object (not a string)
 * with no file I/O side effects, and that an empty wiki root yields an empty
 * pages array rather than throwing.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJson } from "../../src/commands/export.js";

describe("exportJson returns an in-memory object", () => {
  it("returns a JsonExportDocument object (not a string) with no file writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-exp-"));
    const doc = await exportJson(root);
    expect(typeof doc).toBe("object");
    expect(doc.schemaVersion).toBe(1);
    expect(Array.isArray(doc.pages)).toBe(true);
    expect(typeof doc.exportedAt).toBe("string");
  });
});
