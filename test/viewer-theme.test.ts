/**
 * Theme upgrade and selection behavior through the real pre-paint bootstrap.
 * Seed browser state before any script runs so first-load resolution, migration,
 * inaccessible storage, and the public module binding are exercised together.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { emptyBootstrapResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

const KEY = "llmwiki.viewer.theme.v1";
const OLD_KEY = "llmwiki-viewer-theme";
const IDS = ["scientific-clay", "minimal", "nebula-light", "nebula-dark"];

/** Mount with preferences present before the classic head script evaluates. */
function mount(newValue?: string, legacy?: string) {
  return mountViewerDom(emptyBootstrapResponse, "", "present", (window) => {
    if (newValue !== undefined) window.localStorage.setItem(KEY, newValue);
    if (legacy !== undefined) window.localStorage.setItem(OLD_KEY, legacy);
  });
}

describe("viewer theme selection", () => {
  it("defaults to Clay and labels the complete native selector", async () => {
    const { dom } = await mount();
    const doc = dom.window.document;
    const select = doc.querySelector<HTMLSelectElement>("[data-theme-select]")!;
    expect(doc.documentElement.dataset.theme).toBe("scientific-clay");
    expect(select.value).toBe("scientific-clay");
    expect([...select.options].map((option) => option.value)).toEqual(IDS);
    expect(doc.querySelector(`label[for="${select.id}"]`)?.textContent).toContain("Theme");
  });

  it.each(IDS)("restores %s before mounting the route", async (theme) => {
    const { dom } = await mount(theme, "dark");
    expect(dom.window.document.documentElement.dataset.theme).toBe(theme);
    expect(dom.window.localStorage.getItem(OLD_KEY)).toBe("dark");
  });

  it.each(["light", "dark"])("migrates legacy %s exactly once", async (legacy) => {
    const first = await mount(undefined, legacy);
    expect(first.dom.window.document.documentElement.dataset.theme).toBe(`nebula-${legacy}`);
    const saved = first.dom.window.localStorage.getItem(KEY)!;
    expect(saved).toBe(`nebula-${legacy}`);
    const second = await mount(saved, legacy === "light" ? "dark" : "light");
    expect(second.dom.window.document.documentElement.dataset.theme).toBe(saved);
  });

  it.each(["", "dark", "../theme.css", "x".repeat(33), "<script>"])("rejects new preference %j without reviving legacy", async (value) => {
    const { dom } = await mount(value, "dark");
    expect(dom.window.document.documentElement.dataset.theme).toBe("scientific-clay");
  });

  it("switches in place and persists without fetching or resetting route content", async () => {
    const { dom, fetchMock } = await mount();
    const doc = dom.window.document;
    const content = doc.querySelector("[data-main-pane]")!.firstChild;
    const requests = fetchMock.mock.calls.length;
    const select = doc.querySelector<HTMLSelectElement>("[data-theme-select]")!;
    for (const theme of IDS) {
      select.value = theme;
      select.dispatchEvent(new dom.window.Event("change"));
      expect(doc.documentElement.dataset.theme).toBe(theme);
      expect(dom.window.localStorage.getItem(KEY)).toBe(theme);
      expect(doc.querySelector("[data-main-pane]")!.firstChild).toBe(content);
    }
    expect(fetchMock.mock.calls).toHaveLength(requests);
  });

  it.each(["getItem", "setItem"])("keeps selection usable when storage %s throws", async (method) => {
    const { dom } = await mountViewerDom(emptyBootstrapResponse, "", "present", (window) => {
      // Storage is exotic: override the prototype to model browser failures.
      Object.defineProperty(window.Storage.prototype, method, { value() { throw new Error("disabled"); } });
    });
    const select = dom.window.document.querySelector<HTMLSelectElement>("[data-theme-select]")!;
    select.value = "minimal";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(dom.window.document.documentElement.dataset.theme).toBe("minimal");
  });

  it("preserves the legacy choice when writing its migration fails", async () => {
    const { dom } = await mountViewerDom(emptyBootstrapResponse, "", "present", (window) => {
      window.localStorage.setItem(OLD_KEY, "dark");
      Object.defineProperty(window.Storage.prototype, "setItem", { value() { throw new Error("disabled"); } });
    });
    expect(dom.window.document.documentElement.dataset.theme).toBe("nebula-dark");
    expect(dom.window.localStorage.getItem(KEY)).toBeNull();
  });

  it("loads the non-module bootstrap before stylesheets", async () => {
    const html = await readFile("src/viewer/assets/index.html", "utf8");
    const script = '<script src="/assets/viewer-theme-boot.js"></script>';
    expect(html).toContain(script);
    expect(html.indexOf(script)).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });
});
