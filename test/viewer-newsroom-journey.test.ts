/**
 * @file test/viewer-newsroom-journey.test.ts
 * @description Exercises a Newsroom-shaped verified envelope through the real,
 * product-neutral journey DOM in both core-owned viewer themes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";
import { pagesResponse } from "./fixtures/journey-fixtures.js";

const RUN_PATH = "/api/workflows/story-production/runs/story-1";
const RUN_HASH = "#/workflows/story-production/runs/story-1";
const DIGEST = `sha256:${"a".repeat(64)}`;

/** One verified stage with optional generic facts. */
function verified(stageId: string, extra: Record<string, unknown> = {}) {
  return {
    stageId, status: "completed", verification: "verified",
    summary: `${stageId} completed with verified authority.`, appliedTargets: [], evidenceDigests: [], ...extra,
  };
}

/** Complete six-stage envelope shaped exactly as the Newsroom provider emits it. */
function newsroomEnvelope() {
  const stages: Array<Record<string, unknown>> = [
      verified("ingest-sources"),
      verified("frame-story", { factPanel: { title: "Story frame", rows: [
        { label: "Headline", value: "Transient Report", tone: "neutral" },
        { label: "Lifecycle", value: "published", tone: "success" },
        { label: "Predecessor run", value: "story-prior", tone: "neutral" },
      ] } }),
      verified("develop-draft", { appliedTargets: ["articles/transient-report"] }),
      verified("fact-check", { groundedRefs: ["newsroom-retained-source/source-a@sha256:abc"],
        factPanel: { title: "Fact-check coverage", rows: [
          { label: "Coverage", value: "Complete", tone: "success" },
          { label: "Supported", value: "2", tone: "success" },
        ] } }),
      verified("review-story", { gate: { gateId: "editor-approval", gateKind: "human", state: "approved",
        actor: "editor@example.test", actorKind: "human", at: "2026-09-04T12:00:00Z", subjectDigest: DIGEST } }),
      verified("package-story", { outputRef: { artifactType: "newsroom-story-package", slug: "story-1", sha256: DIGEST.slice(7) },
        pdfRef: { artifactType: "newsroom-story-package", slug: "story-1", sha256: DIGEST, member: "story.pdf" } }),
  ];
  return { workflowId: "story-production", runId: "story-1", stateVersion: 12,
    classification: "current", generatedAt: "2026-09-04T12:00:00Z", stages };
}

/** Mount the same generic story journey under one selected theme. */
async function mountTheme(theme: "scientific-clay" | "minimal") {
  const responder: FetchResponder = (url) => url === "/api/pages" ? pagesResponse()
    : url === RUN_PATH ? jsonResponse(newsroomEnvelope()) : null;
  const mounted = await mountViewerDom(responder, RUN_HASH);
  mounted.dom.window.document.documentElement.dataset.theme = theme;
  await mounted.flush();
  return mounted.dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

afterEach(() => vi.restoreAllMocks());

describe("generic viewer with a Newsroom journey", () => {
  for (const theme of ["scientific-clay", "minimal"] as const) {
    it(`renders the complete editorial journey in ${theme}`, async () => {
      const main = await mountTheme(theme);
      expect([...main.querySelectorAll(".journey-stage-id")].map((node) => node.textContent)).toEqual([
        "ingest-sources", "frame-story", "develop-draft", "fact-check", "review-story", "package-story",
      ]);
      expect(main.querySelector(".journey-provenance-caption")?.textContent).toBe("What happened");
      expect(main.textContent).not.toContain("scientifically");
      expect(main.querySelector(".journey-fact-panel")?.textContent).toContain("Transient Report");
      expect(main.querySelector(".journey-fact-panel")?.textContent).toContain("story-prior");
      expect(main.textContent).toContain("Fact-check coverage");
      expect(main.querySelector("[data-stage-id='review-story']")?.firstElementChild?.classList)
        .toContain("journey-gate-human");
      expect(main.querySelector(".journey-gate-byline")?.textContent).toContain("sha256:aaaaaaaaaaaa…");
      expect(main.querySelector("iframe.journey-pdf-frame")?.getAttribute("src"))
        .toBe("/api/workflows/story-production/runs/story-1/pdf");
      expect(main.querySelector(".journey-artifact-link")?.textContent).toContain("newsroom-story-package");
    });
  }

  it("never renders forged fact rows from a recorded-only stage", async () => {
    const envelope = newsroomEnvelope();
    envelope.stages[3] = { ...envelope.stages[3], verification: "recorded-only",
      factPanel: { title: "FORGED", rows: [{ label: "FORGED", value: "FORGED", tone: "success" }] } };
    const responder: FetchResponder = (url) => url === "/api/pages" ? pagesResponse()
      : url === RUN_PATH ? jsonResponse(envelope) : null;
    const { dom, flush } = await mountViewerDom(responder, RUN_HASH);
    await flush();
    expect(dom.window.document.querySelector("[data-main-pane]")?.textContent).not.toContain("FORGED");
  });
});
