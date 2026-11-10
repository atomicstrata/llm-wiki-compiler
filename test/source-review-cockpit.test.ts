/** Exercise the shipped cockpit renderer and native selection controls without a live model. */
import { afterEach, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { createDemo } from "./fixtures/source-review-project.js";
import { collectSourceReview } from "../src/viewer/source-review/report.js";
import { emptyBootstrapResponse, jsonResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Real projection with a second candidate, served through the existing DOM harness. */
async function mountCockpit() {
  const root = await createDemo(); roots.push(root);
  const report = await collectSourceReview(root);
  report.pages[0].candidates.push({ ...report.pages[0].candidates[0], id: "alternate",
    body: "---\ntitle: New title\n---\nAlternate body" });
  const mounted = await mountViewerDom(url => url.endsWith("/api/source-changes")
    ? jsonResponse(report) : emptyBootstrapResponse(url), "#/source-changes");
  return { ...mounted, root };
}

it("shows bounds and an exact command that follows the selected proposal", async () => {
  const { dom, root } = await mountCockpit();
  try {
    const document = dom.window.document;
    expect(document.querySelector(".sc-metrics")?.textContent).toContain("1 of 1");
    expect(document.querySelector(".sc-command pre")?.textContent).toContain(root);
    const select = document.querySelector(".sc-proposal-select") as HTMLSelectElement;
    select.selectedIndex = 1; select.dispatchEvent(new dom.window.Event("change"));
    expect(document.querySelector(".sc-command pre")?.textContent).toContain("review show -- 'alternate'");
    expect(document.querySelector(".sc-proposed")?.textContent).toContain("Alternate body");
    expect(document.querySelector(".sc-proposed")?.textContent).toContain("changes page metadata");
  } finally { dom.window.close(); }
});

it("copies without invoking a server mutation", async () => {
  const { dom, fetchMock, flush } = await mountCockpit();
  try {
    let copied = "";
    Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
    const before = fetchMock.mock.calls.length;
    (dom.window.document.querySelector(".sc-command button") as HTMLButtonElement).click();
    await flush();
    expect(copied).toContain("review show -- 'timeout-proposal'");
    expect(dom.window.document.querySelector(".sc-command [role=status]")?.textContent).toContain("Copied");
    expect(fetchMock.mock.calls).toHaveLength(before);
  } finally { dom.window.close(); }
});
