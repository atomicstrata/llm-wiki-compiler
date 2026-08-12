/**
 * The dashboard must not describe authored pages as compiled.
 *
 * A default project's pages are produced by `llmwiki compile`, so the mockup's
 * "Recently compiled" and its `$ llmwiki compile` empty state are accurate and
 * stay verbatim. A profile's typed entity pages are AUTHORED by hand under the
 * directories the profile declares — no CLI command produces one — so the same
 * copy would name a command that cannot do what the panel is waiting for.
 *
 * `viewer-lists.js` already draws this distinction for a typed list's empty
 * state; these tests pin the dashboard to the same line.
 */

import { describe, expect, it } from "vitest";
import { flushMicrotasks, jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const ENTITY_TYPES = [
  { type: "articles", pageCount: 0 },
  { type: "desks", pageCount: 0 },
];

function envelope(withProfile: boolean): Record<string, unknown> {
  return {
    project: { title: "demo", rootName: "demo" },
    profileId: withProfile ? "newsroom" : "default",
    counts: { concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0 },
    pages: [],
    recentPages: [],
    index: { available: false },
    ...(withProfile ? { profilePipeline: { entityTypes: ENTITY_TYPES } } : {}),
  };
}

function responderFor(withProfile: boolean): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelope(withProfile));
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.endsWith("/api/graph")) return jsonResponse({ nodes: [], edges: [] });
    return null;
  };
}

/** The dashboard's recent panel, mounted for a default or profile project. */
async function recentPanel(withProfile: boolean): Promise<Element> {
  const { dom } = await mountViewerDom(responderFor(withProfile));
  await flushMicrotasks();
  const panels = [...dom.window.document.querySelectorAll("[data-main-pane] .panel")];
  return panels.find((p) => /Recently/.test(p.textContent ?? ""))!;
}

describe("a default project keeps the mockup's compile vocabulary", () => {
  it('titles the panel "Recently compiled"', async () => {
    expect((await recentPanel(false)).querySelector(".panel-title")?.textContent).toBe("Recently compiled");
  });

  it("offers llmwiki compile in the empty state", async () => {
    const panel = await recentPanel(false);
    expect(panel.querySelector(".empty-state-title")?.textContent).toBe("Nothing compiled yet");
    expect(panel.querySelector(".empty-state-command")?.textContent).toContain("llmwiki compile");
  });
});

describe("a profile project does not call authored pages compiled", () => {
  it('titles the panel "Recently updated"', async () => {
    expect((await recentPanel(true)).querySelector(".panel-title")?.textContent).toBe("Recently updated");
  });

  it("names no command, because none produces an entity page", async () => {
    const panel = await recentPanel(true);
    expect(panel.querySelector(".empty-state-title")?.textContent).toBe("Nothing authored yet");
    expect(panel.querySelector(".empty-state-command")).toBeNull();
  });

  it("never says compiled anywhere in the panel", async () => {
    expect((await recentPanel(true)).textContent).not.toMatch(/compil/i);
  });
});
