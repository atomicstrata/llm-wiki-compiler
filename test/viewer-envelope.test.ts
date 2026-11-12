/**
 * `/api/pages` envelope contract for the Nebula dashboard.
 *
 * Every field asserted here is already computed at snapshot build time; the
 * envelope simply did not serialise it. These tests pin the additions so a
 * future refactor cannot quietly drop a field the dashboard renders.
 */

import { describe, expect, it } from "bun:test";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { seedSampleNotesProject, writeMarkdownPage } from "./fixtures/profile-fixtures.js";

const { start: startViewer } = useViewerProcessLifecycle();

/** One collector problem as the envelope serialises it. */
interface ProblemView {
  kind: string;
  entityType?: string;
  path?: string;
  message: string;
}

interface Envelope {
  profileId: string;
  counts: Record<string, number>;
  graph: { nodeCount: number; edgeCount: number; danglingCount: number };
  sourceFilenames: string[];
  pages: { citationCount: number; unresolvedCitationCount: number }[];
  profileProblems?: ProblemView[];
  profileProblemTotal?: number;
}

/** Seed a one-page project whose body carries a citation and a dangling link. */
async function seedProject(): Promise<string> {
  const root = await makeTempRoot("viewer-envelope");
  await writePage(
    path.join(root, CONCEPTS_DIR),
    "alpha",
    { title: "Alpha" },
    "Alpha cites a source.^[missing.md:1-2] It links to [[Nowhere]].",
  );
  return root;
}

/** Start a viewer against `root` and read its /api/pages envelope. */
async function fetchEnvelope(root: string): Promise<Envelope> {
  const handle = await startViewer(root);
  const res = await fetch(`http://${handle.host}:${handle.port}/api/pages`);
  return (await res.json()) as Envelope;
}

describe("/api/pages envelope", () => {
  it("serialises the freshness and compiled-source counts", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(env.counts).toHaveProperty("stale");
    expect(env.counts).toHaveProperty("orphaned");
    expect(env.counts).toHaveProperty("compiledSources");
  });

  it("serialises the graph summary instead of the full adjacency payload", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(typeof env.graph.nodeCount).toBe("number");
    expect(typeof env.graph.edgeCount).toBe("number");
    expect(env.graph.danglingCount).toBeGreaterThan(0);
  });

  it("defaults profileId to 'default' for the built-in profile", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(env.profileId).toBe("default");
  });

  it("serialises sourceFilenames", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(Array.isArray(env.sourceFilenames)).toBe(true);
  });

  it("carries per-page citation counts", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(env.pages[0].citationCount).toBe(1);
    expect(env.pages[0].unresolvedCitationCount).toBe(1);
  });

  it("omits the profile problem fields for a healthy default-profile project", async () => {
    const env = await fetchEnvelope(await seedProject());
    expect(env.profileProblems).toBeUndefined();
    expect(env.profileProblemTotal).toBeUndefined();
  });
});

/** Seed a non-default `notes` project whose second page omits its required `title`. */
async function seedBrokenProfileProject(): Promise<string> {
  const root = await makeTempRoot("viewer-envelope-profile");
  await seedSampleNotesProject(root);
  await writeMarkdownPage(root, "wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title.");
  return root;
}

describe("/api/pages envelope — profile collector problems", () => {
  it("serialises the collector's problems and their true total", async () => {
    const env = await fetchEnvelope(await seedBrokenProfileProject());
    expect(env.profileProblems?.length).toBeGreaterThan(0);
    expect(env.profileProblemTotal).toBe(env.profileProblems?.length);
    expect(env.profileProblems?.[0].message).toContain("title");
  });

  /**
   * The docstring on `ProfileSummaryBlock.problems` promises project-relative
   * paths, but a docstring is not a guarantee: an absolute path already leaked
   * through `/api/health` once on this branch. Assert it at the wire, where the
   * value crosses into the DOM.
   */
  it("never puts an absolute or escaping path on the wire", async () => {
    const root = await seedBrokenProfileProject();
    const env = await fetchEnvelope(root);
    for (const view of env.profileProblems ?? []) {
      if (view.path === undefined) continue;
      expect(path.isAbsolute(view.path)).toBe(false);
      expect(view.path.startsWith("..")).toBe(false);
      expect(view.path).not.toContain(root);
    }
  });
});
