/**
 * Tests for the schema layer: loader, defaults, and helper utilities.
 *
 * Each describe block exercises one schema API surface. Tests build small
 * temporary project roots so loader behaviour can be verified end-to-end
 * across the JSON, YAML, and missing-file paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import {
  buildDefaultSchema,
  countWikilinks,
  loadSchema,
  resolvePageKind,
  serializeSchemaToYaml,
  PAGE_KINDS,
} from "../src/schema/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "schema-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("buildDefaultSchema", () => {
  it("includes a rule for every PageKind", () => {
    const schema = buildDefaultSchema();
    for (const kind of PAGE_KINDS) {
      expect(schema.kinds[kind]).toBeDefined();
      expect(typeof schema.kinds[kind].minWikilinks).toBe("number");
    }
  });

  it("uses concept as the default kind", () => {
    expect(buildDefaultSchema().defaultKind).toBe("concept");
  });

  it("reports loadedFrom as null when no file is present", () => {
    expect(buildDefaultSchema().loadedFrom).toBeNull();
  });

  it("requires more wikilinks for overview than for concept", () => {
    const schema = buildDefaultSchema();
    expect(schema.kinds.overview.minWikilinks).toBeGreaterThan(
      schema.kinds.concept.minWikilinks,
    );
  });
});

describe("loadSchema", () => {
  it("returns defaults when no schema file exists", async () => {
    const schema = await loadSchema(tmpDir);
    expect(schema.loadedFrom).toBeNull();
    expect(schema.defaultKind).toBe("concept");
    expect(schema.timeline.enabled).toBe(false);
  });

  it("turns the timeline on only when enabled is true, and rejects an unknown time zone", async () => {
    await mkdir(path.join(tmpDir, ".llmwiki"), { recursive: true });
    const write = (timeline: unknown) => writeFile(path.join(tmpDir, ".llmwiki/schema.json"), JSON.stringify({ timeline }));
    await write({ enabled: true, timeZone: "America/New_York" });
    expect((await loadSchema(tmpDir)).timeline).toEqual({ enabled: true, timeZone: "America/New_York" });
    await write({ enabled: "yes" });
    expect((await loadSchema(tmpDir)).timeline.enabled).toBe(false);
    await write({ enabled: true, timeZone: "Mars/Olympus" });
    await expect(loadSchema(tmpDir)).rejects.toThrow('timeline.timeZone "Mars/Olympus" is not a known IANA time zone');
  });

  it("loads a JSON schema from .llmwiki/schema.json", async () => {
    await mkdir(path.join(tmpDir, ".llmwiki"), { recursive: true });
    const config = { defaultKind: "entity", kinds: { entity: { minWikilinks: 4 } } };
    await writeFile(path.join(tmpDir, ".llmwiki/schema.json"), JSON.stringify(config));

    const schema = await loadSchema(tmpDir);
    expect(schema.defaultKind).toBe("entity");
    expect(schema.kinds.entity.minWikilinks).toBe(4);
    expect(schema.loadedFrom).toContain("schema.json");
  });

  it("loads a YAML schema from wiki/.schema.yaml", async () => {
    await mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    const yaml =
      "version: 1\ndefaultKind: concept\nkinds:\n  comparison:\n    minWikilinks: 5\n";
    await writeFile(path.join(tmpDir, "wiki/.schema.yaml"), yaml);

    const schema = await loadSchema(tmpDir);
    expect(schema.kinds.comparison.minWikilinks).toBe(5);
    expect(schema.loadedFrom).toContain(".schema.yaml");
  });

  it("ignores invalid defaultKind values", async () => {
    await mkdir(path.join(tmpDir, ".llmwiki"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".llmwiki/schema.json"),
      JSON.stringify({ defaultKind: "not-a-real-kind" }),
    );

    const schema = await loadSchema(tmpDir);
    expect(schema.defaultKind).toBe("concept");
  });

  it("normalises seed pages and drops invalid entries", async () => {
    await mkdir(path.join(tmpDir, ".llmwiki"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".llmwiki/schema.json"),
      JSON.stringify({
        seedPages: [
          { title: "Project Overview", kind: "overview", summary: "Top-level map" },
          { title: "", kind: "overview" },
          { title: "Bad Kind", kind: "nope" },
        ],
      }),
    );

    const schema = await loadSchema(tmpDir);
    expect(schema.seedPages).toHaveLength(1);
    expect(schema.seedPages[0].title).toBe("Project Overview");
  });
});

describe("resolvePageKind", () => {
  it("returns the raw kind when it matches a known PageKind", () => {
    const schema = buildDefaultSchema();
    expect(resolvePageKind("comparison", schema)).toBe("comparison");
  });

  it("falls back to schema default for missing or invalid kind", () => {
    const schema = buildDefaultSchema();
    expect(resolvePageKind(undefined, schema)).toBe("concept");
    expect(resolvePageKind("not-real", schema)).toBe("concept");
  });
});

describe("countWikilinks", () => {
  it("counts each [[wikilink]] occurrence", () => {
    expect(countWikilinks("See [[A]] and [[B]] and again [[A]].")).toBe(3);
  });

  it("returns zero for body without links", () => {
    expect(countWikilinks("Plain prose only.")).toBe(0);
  });
});

describe("serializeSchemaToYaml", () => {
  it("omits the runtime loadedFrom field", () => {
    const yaml = serializeSchemaToYaml(buildDefaultSchema());
    expect(yaml).not.toContain("loadedFrom");
    expect(yaml).toContain("defaultKind");
  });
});
