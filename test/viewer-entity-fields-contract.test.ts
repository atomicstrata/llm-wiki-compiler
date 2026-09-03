/**
 * @file test/viewer-entity-fields-contract.test.ts
 * @description The seam between the server's schema projection and the client's
 * declared-field renderer.
 *
 * Everything else about this feature is tested on ONE side of that seam.
 * `viewer-profile-schema.test.ts` pins what `buildPipelineEnvelope` emits;
 * `viewer-entity-fields.test.ts` pins what the renderer draws — from a
 * HAND-WRITTEN envelope. Both stay green if the two disagree: emit `fields` as a
 * map instead of an ordered array, or rename `name` to `key`, and the projection
 * suite passes, the renderer suite passes, and the feature is dead in the
 * browser with nothing red.
 *
 * So this file writes a profile, runs the REAL projection over it, and hands the
 * result to the REAL renderer as its `/api/pages` body. Nothing in the middle is
 * hand-written, which is the only way the contract is actually asserted.
 */

import { describe, expect, it } from "vitest";
import { buildPipelineDefinitions, buildPipelineEnvelope } from "../src/viewer/pipeline.js";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A profile exercising every facet the renderer branches on. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "newsroom",
  entities: {
    articles: {
      directory: "wiki/articles",
      titleField: "headline",
      fields: {
        headline: { type: "string", required: true },
        wordCount: { type: "integer" },
        syndicated: { type: "boolean" },
        topics: { type: "string[]" },
        stage: { type: "enum", enum: ["draft", "filed"] },
        homepage: { type: "string", format: "url" },
        proofs: { type: "artifactRef", artifactTypes: ["photo"] },
      },
    },
  },
  artifacts: { photo: { fileName: "photo.json", contentKind: "json", maxBytes: 1024 } },
};

/** The frontmatter of the page under test — one value per declared facet. */
const FRONTMATTER = {
  headline: "Harbour lease records released",
  wordCount: 900,
  syndicated: false,
  topics: ["politics", "local"],
  stage: "filed",
  homepage: "https://example.org/story",
  proofs: "photo:alpha@abc123",
};

/**
 * Serve the envelope the SERVER would actually build, plus a typed page.
 *
 * `buildPipelineEnvelope` is called for real, with a summary shaped as the
 * profile collector produces one — so the `profilePipeline` block the client
 * receives here is byte-for-byte what `/api/pages` emits.
 */
const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) {
    const pipeline = buildPipelineEnvelope(buildPipelineDefinitions(PROFILE), {
      profileId: "newsroom",
      entityCounts: { articles: 1 },
    } as never);
    return jsonResponse({
      project: { title: "demo", rootName: "demo" },
      profileId: "newsroom",
      counts: {},
      pages: [],
      recentPages: [],
      index: { available: false },
      profilePipeline: pipeline,
    });
  }
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  if (url.includes("/api/page/")) {
    return jsonResponse({
      pageDirectory: "articles",
      entityType: "articles",
      slug: "harbour",
      title: FRONTMATTER.headline,
      html: "<p>Released on 3 August.</p>",
      warnings: [],
      frontmatter: FRONTMATTER,
    });
  }
  return null;
};

/** Mount the typed page against the real projection and return the rail. */
async function rail(): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(responder);
  dom.window.location.hash = "#/articles/harbour";
  await flushMicrotasks();
  return dom.window.document.querySelector("[data-support-rail]") as HTMLElement;
}

describe("the real projection drives the real renderer", () => {
  it("renders a block at all, which a shape mismatch would silently prevent", async () => {
    expect((await rail()).querySelector("[data-entity-fields]")).not.toBeNull();
  });

  it("renders the declared fields in the profile's declaration order", async () => {
    const labels = Array.from((await rail()).querySelectorAll("[data-entity-fields] dt")).map(
      (node) => node.textContent,
    );
    // `headline` is absent: it is the declared title, already shown as the heading.
    expect(labels).toEqual(["wordCount", "syndicated", "topics", "stage", "homepage", "proofs"]);
  });

  it("branches on each declared type as projected", async () => {
    const block = (await rail()).querySelector("[data-entity-fields]") as HTMLElement;
    expect(block.querySelector(".entity-field-state")?.textContent).toBe("filed");
    expect(block.querySelectorAll(".entity-field-list li")).toHaveLength(2);
    expect(block.textContent).toContain("No");
    expect(block.querySelector(".entity-field-unresolved")).not.toBeNull();
  });

  it("linkifies the field whose declared format survived the projection", async () => {
    const block = (await rail()).querySelector("[data-entity-fields]") as HTMLElement;
    const anchor = block.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.org/story");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("suppresses the declared title, which the heading already carries", async () => {
    const doc = (await rail()).ownerDocument;
    expect(doc.querySelector("[data-main-pane] h1")?.textContent).toBe(FRONTMATTER.headline);
    expect((await rail()).textContent).not.toContain("headline");
  });
});
