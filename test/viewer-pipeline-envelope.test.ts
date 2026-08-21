/**
 * @file test/viewer-pipeline-envelope.test.ts
 * @description The `/api/pages` server leg that carries a profile's pipeline.
 *
 * Everything the Pipeline panel draws already existed on the server and none of
 * it reached the client: the per-type VALID page counts and the UNFILTERED
 * lifecycle-state tally live on `ProfileSummaryBlock`, while the lifecycle and
 * relation DECLARATIONS live only on the loaded profile pack. These tests pin
 * the joined projection, and — just as load-bearing — pin that a DEFAULT project
 * gains nothing at all, so its envelope stays byte-identical.
 *
 * The transition chain is deliberately NOT emitted: the client derives it from
 * `initial` + `transitions`, so the wire carries the declaration and never a
 * pre-chewed order that could disagree with the profile.
 */

import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { startViewerServer } from "../src/viewer/server.js";
import { buildPipelineDefinitions, buildPipelineEnvelope } from "../src/viewer/pipeline.js";
import type { ProfilePack } from "../src/profile/types.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";
import { PIPELINE_PROFILE, seedPipelinePages } from "./fixtures/pipeline-project.js";

interface PipelineFieldRow {
  name: string;
  type: string;
  required?: boolean;
  enum?: string[];
  artifactTypes?: string[];
}
interface PipelineArtifactRow {
  type: string;
  fileName: string;
  contentKind: string;
  metadata?: PipelineFieldRow[];
}
interface PipelineRow {
  type: string;
  directory: string;
  titleField?: string;
  fields?: PipelineFieldRow[];
  pageCount: number;
  stateCounts?: Record<string, number>;
  lifecycle?: {
    field: string;
    initial: string;
    terminal: string[];
    transitions: Record<string, string[]>;
    declaredStates?: string[];
  };
}
interface PipelineEnvelope {
  entityTypes: PipelineRow[];
  relationTypes?: { type: string; from: string[]; to: string[]; direction: string; count: number }[];
  artifactTypes?: PipelineArtifactRow[];
}

const handles: { close(): Promise<void> }[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

/** Boot an in-process viewer over `root` and return its base URL. */
async function startViewer(root: string): Promise<string> {
  roots.push(root);
  const handle = await startViewerServer(await buildViewerSnapshot(root), { host: "127.0.0.1", port: 0 });
  handles.push(handle);
  return `http://${handle.host}:${handle.port}`;
}

/** GET `/api/pages` from a viewer over the seeded pipeline project. */
async function pipelineEnvelope(): Promise<PipelineEnvelope> {
  const root = await makeTempRoot("viewer-pipeline");
  await writeProfileFile(root, PIPELINE_PROFILE);
  await seedPipelinePages(root);
  const url = await startViewer(root);
  const body = (await (await fetch(`${url}/api/pages`)).json()) as Record<string, unknown>;
  return body.profilePipeline as PipelineEnvelope;
}

/** The row for one entity type. */
async function rowFor(type: string): Promise<PipelineRow> {
  const pipeline = await pipelineEnvelope();
  return pipeline.entityTypes.find((row) => row.type === type) as PipelineRow;
}

describe("/api/pages — profilePipeline on a profile project", () => {
  it("lists every declared entity type, including a type with no pages", async () => {
    const pipeline = await pipelineEnvelope();
    expect(pipeline.entityTypes.map((row) => row.type)).toEqual(["articles", "desks", "bylines"]);
  });

  it("carries the lifecycle DECLARATION, not a derived chain", async () => {
    const row = await rowFor("articles");
    expect(row.lifecycle).toEqual({
      field: "stage",
      initial: "draft",
      terminal: ["published"],
      transitions: { draft: ["edited"], edited: ["published"], killed: [] },
      declaredStates: ["draft", "edited", "published", "killed"],
    });
    expect(row).not.toHaveProperty("chain");
  });

  it("counts VALID pages only in pageCount and every page in stateCounts", async () => {
    const row = await rowFor("articles");
    // 3 valid drafts + 1 headline-less draft, 1 edited, 2 published, 1 headline-less killed.
    expect(row.pageCount).toBe(6);
    expect(row.stateCounts).toEqual({ draft: 4, edited: 1, published: 2, killed: 1 });
  });

  it("carries a type whose tally matches its valid count with no gap", async () => {
    const row = await rowFor("desks");
    expect(row.pageCount).toBe(3);
    expect(row.stateCounts).toEqual({ active: 2, archived: 1 });
  });

  // `profile/collect.ts` scans `def.directory`, which is declared independently
  // of the type id. A client that rebuilds the path from the id is guessing, and
  // the typed-list empty state guesses out loud — it tells an author which
  // directory to create.
  it("carries each type's DECLARED directory, not its id", async () => {
    const pipeline = await pipelineEnvelope();
    const onWire = Object.fromEntries(pipeline.entityTypes.map((row) => [row.type, row.directory]));
    const declared = Object.fromEntries(
      Object.entries(PIPELINE_PROFILE.entities).map(([type, def]) => [type, def.directory]),
    );
    expect(onWire).toEqual(declared);
  });

  // Counts are joined onto declarations by indexing summary maps with a
  // PROFILE-DECLARED type name, and the schema puts no `propertyNames` on the
  // entity map — so a type named `constructor` resolves an inherited member on a
  // bare index. The join then reports a function as the count, which
  // `JSON.stringify` drops, so the row reaches the client missing the key it is
  // required to carry. Same class as the `titleField` lookup fixed in #187.
  it("counts a type whose name is an inherited Object property as zero, not as a function", () => {
    const odd: ProfilePack = {
      ...PIPELINE_PROFILE,
      entities: {
        ...PIPELINE_PROFILE.entities,
        constructor: { ...PIPELINE_PROFILE.entities.desks, directory: "wiki/odd" },
      },
    };
    const envelope = buildPipelineEnvelope(buildPipelineDefinitions(odd), {
      profileId: "p",
      entityCounts: {},
      relationCounts: {},
      lifecycleStates: {},
    } as never);
    const row = envelope?.entityTypes.find((r) => r.type === "constructor");

    expect(row?.pageCount).toBe(0);
    expect(row).not.toHaveProperty("stateCounts");
    expect(JSON.parse(JSON.stringify(row))).toHaveProperty("pageCount", 0);
  });

  it("carries a directory that differs from the type id verbatim", () => {
    const renamed: ProfilePack = {
      ...PIPELINE_PROFILE,
      entities: {
        ...PIPELINE_PROFILE.entities,
        desks: { ...PIPELINE_PROFILE.entities.desks, directory: "desks-v2" },
      },
    };
    const definitions = buildPipelineDefinitions(renamed);
    expect(definitions.entityTypes.find((d) => d.type === "desks")?.directory).toBe("desks-v2");
  });

  // The declared SCHEMA half of the block. `buildPipelineDefinitions` is unit
  // tested in viewer-profile-schema.test.ts; these two assert it survives the
  // join onto counts and reaches the wire, which is a separate function.
  it("carries each type's declared titleField and fields through to the wire", async () => {
    const row = await rowFor("articles");
    expect(row.titleField).toBe(PIPELINE_PROFILE.entities.articles.titleField);
    expect(row.fields?.map((field) => field.name)).toEqual(
      Object.keys(PIPELINE_PROFILE.entities.articles.fields ?? {}),
    );
  });

  it("carries the profile's declared artifact types alongside the entity rows", async () => {
    const pipeline = await pipelineEnvelope();
    const declared = Object.keys(PIPELINE_PROFILE.artifacts ?? {});
    expect(pipeline.artifactTypes?.map((row) => row.type) ?? []).toEqual(declared);
  });

  it("carries relation endpoints and direction from the profile", async () => {
    const pipeline = await pipelineEnvelope();
    expect(pipeline.relationTypes).toEqual([
      { type: "filed-under", from: ["articles"], to: ["desks"], direction: "directed", count: 0 },
    ]);
  });
});

describe("/api/pages — profilePipeline is omitted for a default project", () => {
  it("emits no profilePipeline key at all", async () => {
    const root = await makeTempRoot("viewer-pipeline-default");
    await writeMarkdownPage(root, "wiki/concepts", "alpha", "---\ntitle: Alpha\n---\nBody.");
    const url = await startViewer(root);
    const body = (await (await fetch(`${url}/api/pages`)).json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("profilePipeline");
  });
});
