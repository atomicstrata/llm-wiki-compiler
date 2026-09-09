/** Typed profiles distinguish clickable raw source entries from typed source records. */
import { describe, it, expect } from "vitest";
import { mountViewerDom, jsonResponse } from "./fixtures/viewer-jsdom.js";

describe("raw source list access", () => {
  it.each([false, true])("preserves default list shape and enables typed drill-down (%s)", async (typed) => {
    const { dom, flush } = await mountViewerDom((url) => {
      if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
      if (url.endsWith("/api/pages")) return jsonResponse({ project: {}, pages: [], counts: {}, sourceFilenames: ["same name.md"],
        ...(typed ? { profilePipeline: { entityTypes: [{ type: "sources", directory: "wiki/sources" }] } } : {}) });
      return null;
    }, "#/sources");
    await flush();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    const link = main.querySelector("a.list-title");
    expect(link?.getAttribute("href") ?? null).toBe(typed ? "#/_source/same%20name.md" : null);
    expect(main.querySelector("h1")?.textContent).toBe(typed ? "Raw sources" : "Sources");
    if (typed) expect(dom.window.document.querySelector('a[href="#/_type/sources"]')).not.toBeNull();
  });
});
