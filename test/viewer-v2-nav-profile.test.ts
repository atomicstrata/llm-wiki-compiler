/**
 * The v2 sidebar on a profile project, rendered to static markup.
 *
 * A profile's types used to REPLACE Concepts and Queries, so a project that
 * compiles concepts AND a `person` type lost its concepts from the nav. Now the
 * default rows lead (each only when it has pages) and the types follow, under the
 * human label. The Workflows and Lifecycle status rows stay profile-only and
 * appear only when the profile declares workflows or a lifecycle, so the nav
 * never leads to an empty screen.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PagesEnvelope } from "../viewer-v2/src/api.js";
import { navDestinations, Sidebar } from "../viewer-v2/src/nav.js";
import { parseRoute } from "../viewer-v2/src/route.js";
import { entityType, envelope, lifecycle } from "./fixtures/viewer-v2-fixtures.js";

const COUNTS = { concepts: 4, queries: 0, sourceFiles: 1, pendingReviews: 0, compiledSources: 1, stale: 0, orphaned: 0 };

/** A `people` profile project with concepts and a `person` type; override the pipeline. */
function people(pipeline: Partial<NonNullable<PagesEnvelope["profilePipeline"]>> = {}): PagesEnvelope {
  return envelope({
    profileId: "people",
    counts: COUNTS,
    profilePipeline: { entityTypes: [entityType({ type: "person", pageCount: 3 })], ...pipeline },
  });
}

/** The routes of the sidebar's rows, in order. */
function routes(wiki: PagesEnvelope): string[] {
  const html = renderToStaticMarkup(createElement(Sidebar, { wiki, health: null, route: parseRoute("#/") }));
  return [...html.matchAll(/data-route="([\w-]+)"/g)].map((match) => match[1]);
}

describe("Sidebar on a profile project", () => {
  it("shows Concepts beside the profile's types, and drops an empty Queries row", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { wiki: people(), health: null, route: parseRoute("#/") }));
    expect(routes(people()).slice(2, 4)).toEqual(["concepts", "person"]);
    expect(routes(people())).not.toContain("queries");
    expect(html).toMatch(/data-route="person"[^>]*>[\s\S]*?Person/);
  });

  it("shows only the types when the project has no concepts or queries", () => {
    const typesOnly = { ...people(), counts: { ...COUNTS, concepts: 0 } };
    expect(routes(typesOnly).slice(2, 3)).toEqual(["person"]);
    expect(routes(typesOnly)).not.toContain("concepts");
  });

  it("keeps both default rows on a default project, the empty one included", () => {
    expect(routes(envelope({ counts: COUNTS })).slice(2, 4)).toEqual(["concepts", "queries"]);
  });

  it("offers Workflows and Lifecycle status only when the profile declares them", () => {
    expect(routes(people())).not.toContain("workflows");
    expect(routes(people())).not.toContain("pipeline");
    const declared = people({ workflows: ["review"], entityTypes: [entityType({ type: "person", lifecycle: lifecycle() })] });
    expect(routes(declared)).toEqual(expect.arrayContaining(["workflows", "pipeline"]));
  });

  it("never offers them on a default project, whatever it carries", () => {
    const stray = envelope({ profilePipeline: { entityTypes: [entityType({ lifecycle: lifecycle() })], workflows: ["review"] } });
    expect(routes(stray)).not.toContain("workflows");
    expect(routes(stray)).not.toContain("pipeline");
  });

  it("gives the palette the same rows", () => {
    const labels = navDestinations(people(), null).map((destination) => destination.label);
    expect(labels).toEqual(expect.arrayContaining(["Concepts", "Person"]));
    expect(labels).not.toContain("Workflows");
  });
});
