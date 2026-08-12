/**
 * Theme resolution and toggle behaviour.
 *
 * Theme must be resolved before first paint, which rules out an ES module
 * (deferred) and, under the viewer's CSP, an inline script. A classic
 * `viewer-theme-boot.js` in <head> stamps `data-theme`; the module only
 * wires the header button afterwards.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_DEMO_ENVELOPE, jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) return jsonResponse(EMPTY_DEMO_ENVELOPE);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  return null;
};

describe("theme", () => {
  it("defaults to dark when nothing is stored", async () => {
    const { dom } = await mountViewerDom(responder);
    expect(dom.window.document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders a toggle button that names the target theme", async () => {
    const { dom } = await mountViewerDom(responder);
    const button = dom.window.document.querySelector("[data-theme-toggle]");
    expect(button).toBeTruthy();
    expect(button?.getAttribute("aria-label")).toMatch(/light/i);
  });

  it("flips data-theme and persists on click", async () => {
    const { dom, flush } = await mountViewerDom(responder);
    const doc = dom.window.document;
    const button = doc.querySelector("[data-theme-toggle]") as HTMLButtonElement;
    button.click();
    await flush();
    expect(doc.documentElement.dataset.theme).toBe("light");
    expect(dom.window.localStorage.getItem("llmwiki-viewer-theme")).toBe("light");
  });

  it("restores a stored preference on next mount", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.localStorage.setItem("llmwiki-viewer-theme", "light");
    const second = await mountViewerDom(responder);
    second.dom.window.localStorage.setItem("llmwiki-viewer-theme", "light");
    // Re-run the boot script against the stored value.
    second.dom.window.eval("window.__llmwikiResolveTheme();");
    expect(second.dom.window.document.documentElement.dataset.theme).toBe("light");
  });
});
