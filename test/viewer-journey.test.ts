/**
 * Research-journey timeline (P9.4) DOM witnesses.
 *
 * Mounts the real viewer assets through `mountViewerDom` and drives the
 * `#/workflows/<wf>/runs/<run>` route against a mocked P9.1 projection,
 * asserting the rendered DOM: the stage timeline + classification, the
 * human-approval gate lifecycle (distinct HUMAN label, byline only when
 * recorded), verified provenance chips (ONLY on `verification === "verified"`),
 * the recorded-only-with-forged-provenance guarantee, the XSS-safe text sinks,
 * the problem-envelope error panel, and the encoded P9.3 artifact link.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";
import { pagesResponse } from "./fixtures/journey-fixtures.js";

const RUN_PATH = "/api/workflows/build/runs/r1";
const JOURNEY_HASH = "#/workflows/build/runs/r1";

/** A recorded-only stage row with optional overrides (gate, outputRef, forged fields). */
function stage(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { stageId: id, status, verification: "recorded-only", ...extra };
}

/** A verified stage row carrying the given provenance facts. */
function verifiedStage(id: string, facts: Record<string, unknown>): Record<string, unknown> {
  return { stageId: id, status: "completed", verification: "verified", summary: "", appliedTargets: [], ...facts };
}

/** A projection envelope with the given stage rows + classification overrides. */
function projection(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    workflowId: "build", runId: "r1", stateVersion: 1,
    classification: "current", generatedAt: "2026-08-29T00:00:00Z", stages: [], ...overrides,
  };
}

/** Mount the viewer directly on the journey route with `body` as the projection. */
async function mountJourney(body: unknown): Promise<{ dom: import("jsdom").JSDOM; main: HTMLElement }> {
  const responder: FetchResponder = (url) => {
    if (url === "/api/pages") return pagesResponse();
    if (url === RUN_PATH) return jsonResponse(body);
    return null;
  };
  const { dom, flush } = await mountViewerDom(responder, JOURNEY_HASH);
  await flush();
  return { dom, main: dom.window.document.querySelector("[data-main-pane]") as HTMLElement };
}

afterEach(() => vi.restoreAllMocks());

describe("viewer research-journey timeline", () => {
  it("names the budget knob when live verification timed out, and shows no notice once facts applied", async () => {
    const timedOut = await mountJourney(projection({
      stages: [stage("plan", "completed")], live: { outcome: "timed-out", timeoutMs: 60_000 },
    }));
    const notice = timedOut.main.querySelector(".journey-live-notice");
    expect(notice?.textContent).toContain("timed out after 60 s");
    expect(notice?.textContent).toContain("configured projection timeout");
    const applied = await mountJourney(projection({ stages: [stage("plan", "completed")], live: { outcome: "applied" } }));
    expect(applied.main.querySelector(".journey-live-notice")).toBeNull();
  });

  it("renders the stage timeline in roster order with the run classification", async () => {
    const { main } = await mountJourney(projection({
      classification: "needs-adaptation",
      stages: [stage("plan", "completed"), stage("run", "running")],
    }));
    expect(main.querySelector(".journey-classification")?.textContent).toContain("Needs adaptation");
    const ids = [...main.querySelectorAll(".journey-stage-id")].map((e) => e.textContent);
    expect(ids).toEqual(["plan", "run"]);
  });

  it("badges a verified stage as Verified and a recorded-only stage as not verified", async () => {
    const { main } = await mountJourney(projection({
      stages: [verifiedStage("run", { summary: "did work" }), stage("draft", "completed")],
    }));
    const badges = [...main.querySelectorAll(".journey-verification")];
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toBe("Verified");
    expect(badges[0].className).toContain("verification-verified");
    expect(badges[1].textContent).toBe("Recorded · not verified");
    expect(badges[1].className).toContain("verification-recorded");
  });

  it("shows a recorded-only verification category and stable reason code", async () => {
    const { main } = await mountJourney(projection({ stages: [stage("draft", "completed", {
      verificationReason: { category: "timed-out", code: "verification-timeout" },
    })] }));
    const reason = main.querySelector(".journey-verification-reason");
    expect(reason?.textContent).toBe("Timed out · verification-timeout");
    expect((reason as HTMLElement)?.dataset.verificationCategory).toBe("timed-out");
  });

  it("labels a HUMAN gate distinctly and shows the approved byline with actorKind", async () => {
    const { main } = await mountJourney(projection({ stages: [
      stage("review", "awaiting-gate", { gate: { gateId: "g", gateKind: "human", state: "awaiting" } }),
      stage("ship", "completed", { gate: {
        gateId: "g2", gateKind: "human", state: "approved",
        actor: "alice", actorKind: "human", at: "2026-08-29T00:00:00Z", decision: "approve",
      } }),
    ] }));
    const gates = [...main.querySelectorAll(".journey-gate")];
    const gatedStages = [...main.querySelectorAll(".journey-stage")];
    expect(gatedStages.every((row) => row.firstElementChild?.classList.contains("journey-gate-human"))).toBe(true);
    expect(gates[0].className).toContain("gate-awaiting");
    expect(gates[0].className).toContain("journey-gate-human");
    expect(gates[0].textContent).toContain("Human approval — awaiting approval");
    expect(gates[1].querySelector(".journey-gate-byline")?.textContent).toContain("by alice (human)");
    expect(gates[1].querySelector(".journey-gate-byline")?.textContent).toContain("at 2026-08-29T00:00:00Z");
  });

  it("shows an approved gate with no recorded event WITHOUT a fabricated byline", async () => {
    const { main } = await mountJourney(projection({ stages: [
      stage("review", "completed", { gate: { gateId: "g", gateKind: "human", state: "approved" } }),
    ] }));
    const gate = main.querySelector(".journey-gate");
    expect(gate?.textContent).toContain("Human approval — approved");
    expect(gate?.querySelector(".journey-gate-byline")).toBeNull();
  });

  it("renders verified provenance: summary, target chips, and raw digests in a details block", async () => {
    const { main } = await mountJourney(projection({ stages: [verifiedStage("run", {
      summary: "Ran 3 trials", appliedTargets: ["ideas/x", "methods/y"],
      evidenceDigests: ["sha256:aa"], groundedRefs: ["refs/z"],
    })] }));
    expect(main.querySelector(".journey-summary")?.textContent).toBe("Ran 3 trials");
    expect(main.querySelector(".journey-provenance-caption")?.textContent).toBe("What happened");
    const content = [...(main.querySelector(".journey-provenance")?.children ?? [])]
      .filter((child) => !child.classList.contains("journey-provenance-caption"));
    expect(content[0]?.className).toBe("journey-summary");
    expect([...main.querySelectorAll(".journey-chip")].map((c) => c.textContent)).toEqual(["ideas/x", "methods/y"]);
    expect([...main.querySelectorAll(".journey-digest")].map((d) => d.textContent)).toEqual(["sha256:aa", "refs/z"]);
  });

  it("renders verified stage-to-target, evidence, and grounding graph edges", async () => {
    const { main } = await mountJourney(projection({ stages: [verifiedStage("collect-result", {
      summary: "Recorded the result.", appliedTargets: ["page:experiments/cache"],
      evidenceDigests: ["sha256:abc"], groundedRefs: ["papers/source-one"],
    })] }));
    const edges = [...main.querySelectorAll(".journey-edge")];
    expect(edges.map((edge) => edge.getAttribute("data-edge-kind"))).toEqual(["target", "evidence", "grounding"]);
    expect(edges.map((edge) => edge.textContent)).toEqual([
      "collect-result → target: page:experiments/cache",
      "collect-result → evidence: sha256:abc",
      "collect-result → grounds on: papers/source-one",
    ]);
  });

  it("renders NO provenance for a recorded-only row carrying forged verified fields", async () => {
    const { main } = await mountJourney(projection({ stages: [{
      stageId: "run", status: "completed", verification: "recorded-only",
      summary: "FORGED", appliedTargets: ["FORGED"], groundedRefs: ["FORGED"], evidenceDigests: ["sha256:ff"],
    }] }));
    expect(main.querySelector(".journey-provenance")).toBeNull();
    expect(main.querySelector(".journey-edge")).toBeNull();
    expect(main.querySelector(".journey-chip")).toBeNull();
    expect(main.textContent).not.toContain("FORGED");
  });

  it("keeps legacy provider facts without deriving lifecycle from recorded stage ids", async () => {
    const { main } = await mountJourney(projection({ stages: [
      verifiedStage("design-experiment", {
        summary: "Designed the experiment.",
        experimentState: { hypothesis: "Caching reduces latency", slug: "cache-latency", lifecycle: "designed" },
      }),
      stage("execute-experiment", "completed", {
        experimentState: { hypothesis: "FORGED", slug: "forged", lifecycle: "executing", verdict: "FORGED" },
      }),
    ] }));
    const panel = main.querySelector(".journey-experiment");
    expect(panel?.querySelector("[data-experiment-field='hypothesis']")?.textContent).toContain("Caching reduces latency");
    expect(panel?.querySelector("[data-experiment-field='slug']")?.textContent).toContain("cache-latency");
    expect(panel?.querySelector("[data-experiment-field='lifecycle']")?.textContent).toContain("designed");
    expect(panel?.querySelector("[data-experiment-field='lifecycle']")?.textContent).toContain("Verified");
    expect(panel?.textContent).not.toContain("FORGED");
  });

  it("renders HTML-shaped summary and actor as literal text with no injected element", async () => {
    const payload = "<img src=x onerror=window.__xss=1>";
    const { main, dom } = await mountJourney(projection({ stages: [{
      ...verifiedStage("run", { summary: payload, appliedTargets: [] }),
      gate: { gateId: "g", gateKind: "human", state: "approved", actor: payload, actorKind: "human", at: "t" },
    }] }));
    expect(main.querySelector("img")).toBeNull();
    expect(main.querySelector(".journey-summary")?.textContent).toBe(payload);
    expect((dom.window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("renders a visible error panel and no timeline for a problem envelope", async () => {
    const { main } = await mountJourney({ workflowId: "build", runId: "r1", problem: "run unreadable" });
    expect(main.querySelector(".journey-error")?.textContent).toContain("run unreadable");
    expect(main.querySelector(".journey-timeline")).toBeNull();
  });

  it("renders a stage artifact download link at the exact encoded P9.3 URL and creates no iframe", async () => {
    const { main } = await mountJourney(projection({ stages: [{
      stageId: "final step", status: "completed", verification: "recorded-only",
      outputRef: { artifactType: "json", slug: "s", sha256: "sha256:aa" },
    }] }));
    const link = main.querySelector(".journey-artifact-link");
    expect(link?.getAttribute("href")).toBe("/api/workflows/build/runs/r1/stage/final%20step/output");
    expect(link?.hasAttribute("download")).toBe(true);
    expect(main.querySelector("iframe")).toBeNull();
  });
});

const PDF_PATH = "/api/workflows/build/runs/r1/pdf";
const PDF_REF = { artifactType: "paper-build", slug: "m1", sha256: `sha256:${"a".repeat(64)}`, member: "main.pdf" };
const JOURNEY_CSS = path.resolve("src/viewer/assets/viewer-journey.css");

/** Mount the journey route WITH the journey stylesheet, so computed visibility is real. */
async function mountStyledJourney(body: unknown): Promise<{ dom: import("jsdom").JSDOM; main: HTMLElement; css: string }> {
  const css = await readFile(JOURNEY_CSS, "utf8");
  const responder: FetchResponder = (url) => url === "/api/pages" ? pagesResponse() : url === RUN_PATH ? jsonResponse(body) : null;
  const { dom, flush } = await mountViewerDom(responder, JOURNEY_HASH, "present", (window) => {
    const style = window.document.createElement("style");
    style.textContent = css;
    window.document.head.appendChild(style);
  });
  await flush();
  return { dom, main: dom.window.document.querySelector("[data-main-pane]") as HTMLElement, css };
}

describe("viewer research-journey final PDF panel (P9.6)", () => {
  it("renders the Final PDF link + same-origin frame for a VERIFIED stage carrying a well-formed pdfRef, VISIBLY", async () => {
    const { dom, main, css } = await mountStyledJourney(projection({ stages: [verifiedStage("record-build", { evidenceDigests: [], pdfRef: PDF_REF })] }));
    const panel = main.querySelector(".journey-pdf");
    expect(panel, "no .journey-pdf panel").not.toBeNull();
    expect(panel?.querySelector(".journey-pdf-heading")?.textContent).toContain("record-build");
    const link = panel?.querySelector("a.journey-pdf-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(PDF_PATH);
    expect(link.target).toBe("_blank");
    expect(link.textContent).toContain("main.pdf");
    const frame = panel?.querySelector("iframe.journey-pdf-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(PDF_PATH);
    // Visible, not merely present: the stylesheet's rule keeps the frame a block with a real height.
    expect(dom.window.getComputedStyle(frame).display).toBe("block");
    expect(css).toMatch(/\.journey-pdf-frame\s*\{[^}]*min-height/);
  });

  it("shows NO panel for a recorded-only row carrying a forged pdfRef, nor for a verified row with a malformed one", async () => {
    const { main } = await mountJourney(projection({ stages: [
      stage("record-build", "completed", { pdfRef: PDF_REF }),
      verifiedStage("compile-pdf", { evidenceDigests: [], pdfRef: { ...PDF_REF, sha256: "deadbeef" } }),
    ] }));
    expect(main.querySelector(".journey-pdf")).toBeNull();
    expect(main.querySelectorAll(".journey-stage")).toHaveLength(2);
  });
});
