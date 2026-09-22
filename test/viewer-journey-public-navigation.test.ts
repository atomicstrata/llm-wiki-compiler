/**
 * Public viewer and internal workflow journey coexist through one router.
 * Verifies actual rendered links, deep links, and abandoned live-read responses.
 */
import { describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

const RUN = { runId: "run-1", workflow: "build", status: "running", classification: "current" };

/** Minimal bootstrap plus a retained workflow for the public list route. */
function respond(url: string): Response | null {
  if (url.endsWith("/api/pages")) return jsonResponse({ pages: [], counts: {}, profileId: "test", stateStatus: "ok" });
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  if (url.endsWith("/api/workflow-runs")) return jsonResponse({ runs: [RUN], workflowJourneys: true });
  if (url.endsWith("/api/workflows/build/runs/run-1")) return jsonResponse({ ...RUN, stages: [] });
  return null;
}

describe("public workflow journey navigation", () => {
  it("links the public run list to its live retained-record detail", async () => {
    const { dom } = await mountViewerDom(respond, "#/workflows");
    const link = dom.window.document.querySelector('a[href="#/workflows/build/runs/run-1"]');
    expect(link?.textContent).toBe("build");
  });

  it("opens a cold journey deep link instead of mistaking it for an entity page", async () => {
    const { dom, fetchMock } = await mountViewerDom(respond, "#/workflows/build/runs/run-1");
    expect(dom.window.document.querySelector(".journey-pane")?.textContent).toContain("Run run-1");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/page/workflows"))).toBe(false);
  });

  it("does not paint a late journey response over the next route", async () => {
    let settle!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { settle = resolve; });
    const { dom, flush } = await mountViewerDom(url =>
      url.includes("/api/workflows/build/") ? delayed : respond(url), "#/workflows/build/runs/run-1");
    dom.window.location.hash = "#/workflows";
    await flush();
    settle(jsonResponse({ ...RUN, stages: [] }));
    await flush();
    expect(dom.window.document.querySelector(".journey-pane")).toBeNull();
    expect(dom.window.document.querySelector('a[href="#/workflows/build/runs/run-1"]')).not.toBeNull();
  });
});
