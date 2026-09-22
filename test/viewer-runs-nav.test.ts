/**
 * Run-list + router-wide stale-navigation witnesses for the P9.4 client.
 *
 * Covers the public `#/workflows` index (complete rows link, incomplete rows stay inert),
 * the profile-sidebar Workflows entry, and stale-navigation guards:
 * a slow page/journey render that resolves AFTER navigating away must NOT
 * overwrite the current route (both a cross-route case and a journey-to-journey
 * reverse-order case), plus a light accessibility pass on the journey view.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mountViewerDom, profileBootstrapResponse, type FetchResponder } from "./fixtures/viewer-jsdom.js";
import { pagesResponse, deferred, mainPane } from "./fixtures/journey-fixtures.js";

const JOURNEY_HASH = "#/workflows/build/runs/r1";

/** A projection envelope for `runId` with a single named stage. */
function projection(runId: string, stageId: string): Record<string, unknown> {
  return {
    workflowId: "build", runId, stateVersion: 1, classification: "current",
    generatedAt: "2026-08-29T00:00:00Z",
    stages: [{ stageId, status: "completed", verification: "recorded-only" }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("viewer run-list + stale-navigation guard", () => {
  it("lists a complete run as a link and keeps an incomplete row inert", async () => {
    const envelope = { workflowJourneys: true, runs: [
      { runId: "r1", workflow: "build", classification: "current", status: "running", currentStage: "plan" },
      { runId: "r2", problem: "run store unreadable" },
    ] };
    const responder: FetchResponder = (url) =>
      url === "/api/pages" ? pagesResponse() : url === "/api/workflow-runs" ? jsonResponse(envelope) : null;
    const { dom, flush } = await mountViewerDom(responder, "#/workflows");
    await flush();
    const main = mainPane(dom);
    const links = [...main.querySelectorAll("a.list-title[href]")];
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("#/workflows/build/runs/r1");
    expect(main.textContent).toContain("run store unreadable");
  });

  it("retains the public Workflows entry for an active profile", async () => {
    const responder: FetchResponder = profileBootstrapResponse;
    const { dom, flush } = await mountViewerDom(responder);
    await flush();
    const link = dom.window.document.querySelector('a[data-route="workflows"]');
    expect(link?.getAttribute("href")).toBe("#/workflows");
  });

  it("discards a slow page render that resolves AFTER navigating to a journey", async () => {
    const slow = deferred<Response>();
    const responder: FetchResponder = (url) => {
      if (url === "/api/pages") return pagesResponse();
      if (url === "/api/page/concepts/slow") return slow.promise;
      if (url === "/api/workflows/build/runs/r1") return jsonResponse(projection("r1", "plan"));
      return null;
    };
    const { dom, flush } = await mountViewerDom(responder);
    await flush();
    dom.window.location.hash = "#/concepts/slow"; // gen N: page fetch left pending
    await flush();
    dom.window.location.hash = JOURNEY_HASH; // gen N+1: journey resolves + renders
    await flush();
    slow.resolve(jsonResponse({ title: "SLOW PAGE", pageDirectory: "concepts", html: "<p>slow</p>" }));
    await flush();
    const main = mainPane(dom);
    expect(main.querySelector(".journey-classification")).not.toBeNull();
    expect(main.textContent).not.toContain("SLOW PAGE");
  });

  it("keeps the latest journey when an earlier journey fetch resolves last (reverse order)", async () => {
    const slowRun = deferred<Response>();
    const responder: FetchResponder = (url) => {
      if (url === "/api/pages") return pagesResponse();
      if (url === "/api/workflows/build/runs/r1") return slowRun.promise;
      if (url === "/api/workflows/build/runs/r2") return jsonResponse(projection("r2", "stage-two"));
      return null;
    };
    const { dom, flush } = await mountViewerDom(responder);
    await flush();
    dom.window.location.hash = "#/workflows/build/runs/r1"; // pending
    await flush();
    dom.window.location.hash = "#/workflows/build/runs/r2"; // renders r2
    await flush();
    slowRun.resolve(jsonResponse(projection("r1", "stage-one")));
    await flush();
    const ids = [...mainPane(dom).querySelectorAll(".journey-stage-id")].map((e) => e.textContent);
    expect(ids).toEqual(["stage-two"]);
  });

  it("renders the journey view with a single h1 and an ordered timeline list", async () => {
    const responder: FetchResponder = (url) =>
      url === "/api/pages" ? pagesResponse()
        : url === "/api/workflows/build/runs/r1" ? jsonResponse(projection("r1", "plan")) : null;
    const { dom, flush } = await mountViewerDom(responder, JOURNEY_HASH);
    await flush();
    const main = mainPane(dom);
    expect(main.querySelectorAll("h1").length).toBe(1);
    expect(main.querySelector("ol.journey-timeline")).not.toBeNull();
  });
});
