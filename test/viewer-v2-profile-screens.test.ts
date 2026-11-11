/**
 * The v2 viewer's profile-only screens rendered to static markup: the
 * lifecycle status, the workflow run list, a run's journey, and a resolved
 * artifact, each empty and populated.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactDetail } from "../viewer-v2/src/artifact-ref.js";
import { Journey } from "../viewer-v2/src/journey-view.js";
import { PipelineView } from "../viewer-v2/src/pipeline-view.js";
import { nextCommands, WorkflowRuns } from "../viewer-v2/src/workflows-view.js";
import { artifactMetadata, entityType, envelope, lifecycle, recordedStage, verifiedStage, text, workflowRun } from "./fixtures/viewer-v2-fixtures.js";

const IDS = { workflowId: "review", runId: "run-1" };

const PROFILE = envelope({
  profileId: "autosci",
  profileProblems: [{ kind: "field-violation", entityType: "papers", path: "wiki/papers/limbo.md", message: "status is not a declared value" }],
  profileProblemTotal: 2,
  profilePipeline: {
    entityTypes: [
      entityType({ lifecycle: lifecycle(), pageCount: 5, stateCounts: { draft: 3, published: 2, limbo: 1 } }),
      entityType({ type: "notes" }),
    ],
    relationTypes: [{ type: "cites", from: ["papers"], to: ["papers"], direction: "directed", count: 3 }],
    artifactTypes: [{ type: "report", fileName: "report.json", contentKind: "json", metadata: [{ name: "pages", type: "integer" }] }],
  },
});

describe("PipelineView", () => {
  it("shows the teaching card on a default project", () => {
    const html = renderToStaticMarkup(createElement(PipelineView, { wiki: envelope() }));
    expect(html).toContain("No record stages configured");
    expect(html).toContain("$ llmwiki template init");
  });

  it("lays out each type's chain, chips, callout and verdict", () => {
    const html = renderToStaticMarkup(createElement(PipelineView, { wiki: PROFILE }));
    expect(text(html)).toMatch(/^Lifecycle status Current record counts.* AUTOSCI /);
    expect(html).toContain("draft → review → published");
    expect(html).toContain("wiki/papers");
    expect(html).toContain("2 published · terminal");
    expect(html).toContain("1 limbo · unreachable");
    expect(html).toContain("1 page sits in limbo — not a declared `status` value at all, so the configured transitions cannot reach it.");
    expect(html).toContain("1 rejected page counted here");
    expect(text(html)).toContain("— No stages configured");
  });

  it("lists relation and artifact types, the validation warnings, and the lint footer", () => {
    const html = renderToStaticMarkup(createElement(PipelineView, { wiki: PROFILE }));
    expect(text(html)).toContain("Cites Papers → Papers 3 recorded links");
    expect(text(html)).toContain("Report report.json json pages");
    expect(html).toMatch(/<code[^>]*>report\.json<\/code>/);
    expect(html).toMatch(/<code[^>]*>field-violation<\/code>/);
    expect(html).toContain("status is not a declared value");
    expect(html).toContain("1 rejected page still declares a lifecycle state and is counted");
    expect(html).toContain('href="#/health"');
    expect(text(html)).toContain("See all 2 problems in Health →");
    expect(text(html)).toContain("Record problems 2 PROBLEMS");
  });
});

describe("WorkflowRuns", () => {
  it("shows the teaching card when nothing has run", () => {
    const html = renderToStaticMarkup(createElement(WorkflowRuns, { payload: { runs: [] } }));
    expect(html).toContain("No workflow runs");
    expect(html).toContain("$ llmwiki workflow list");
  });

  it("links each run to its journey and names what a parked run waits on, in clearing order", () => {
    const parked = workflowRun({ awaitingOutput: true, nextSubmitEntityType: "papers", awaitingGate: "gate-1" });
    const html = renderToStaticMarkup(createElement(WorkflowRuns, { payload: { runs: [parked, workflowRun({ runId: "run-2", classification: "historical", status: "completed", currentStage: null })] } }));
    expect(html).toContain('href="#/_journey/review/run-1"');
    expect(text(html)).toContain("review run-1");
    expect(html).toContain("running · draft");
    expect(text(html)).toContain("Waiting for results Waiting for approval · gate-1");
    expect(html).toContain("$ llmwiki workflow submit run-1 --kind page --entity-type papers --slug &lt;slug&gt; --body-file &lt;path&gt;");
    expect(html).toContain("$ llmwiki workflow gate approve run-1 gate-1");
    expect(html).toContain("completed · no active step");
    expect(text(html)).toContain("completed · no active step History");
  });

  it("sends a trust gate to a re-submit, never to gate approve, and shows a broken store as a problem", () => {
    const trust = workflowRun({ awaitingGate: "trust:papers", awaitingTrustGate: true });
    const html = renderToStaticMarkup(createElement(WorkflowRuns, { payload: { runs: [trust, { runId: "(store)", classification: "blocked-by-config", problem: "run store unreadable" }] } }));
    expect(html).toContain("Write permission required · trust:papers");
    expect(html).toContain("Set LLMWIKI_TRUSTED_WRITE to grant this profile&#x27;s writes, then re-submit.");
    expect(html).not.toContain("gate approve");
    expect(text(html)).toContain("(store) Problem");
    expect(html).toContain("run store unreadable");
    expect(nextCommands(workflowRun({ awaitingOutput: true, nextSubmitArtifactType: "report" }))).toEqual([
      "$ llmwiki workflow submit run-1 --kind artifact --artifact-type report --slug <slug> --body-file <path>",
    ]);
  });
});

describe("Journey", () => {
  it("shows a problem envelope as a visible error", () => {
    const html = renderToStaticMarkup(createElement(Journey, { body: { ...IDS, problem: "run is not readable" }, ids: IDS }));
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("This run could not be projected: run is not readable");
  });

  it("renders each stage's gate, verification, facts, output and PDF links", () => {
    const sha256 = "b".repeat(64);
    const recorded = recordedStage({
      gate: { gateId: "g", gateKind: "human", state: "awaiting" },
      verificationReason: { category: "stale-or-invalid", code: "pin-mismatch" },
      outputRef: { artifactType: "report", slug: "alpha", sha256 },
    });
    const verified = verifiedStage({ pdfRef: { artifactType: "pdf", slug: "final", sha256, member: "final.pdf" }, factPanel: { title: "Judgement", rows: [{ label: "Verdict", value: "supports", tone: "success" }] } });
    const body = { ...IDS, classification: "current" as const, generatedAt: "", stages: [recorded, verified], live: { outcome: "degraded" as const } };
    const html = renderToStaticMarkup(createElement(Journey, { body, ids: IDS }));
    expect(html).toContain("Run status: Current");
    expect(html).toContain("Live verification was unavailable");
    const visible = text(html);
    expect(visible).toContain("Human approval — awaiting approval");
    expect(visible).toContain("Recorded · not verified Stale or invalid · pin-mismatch");
    expect(html).toContain('href="/api/workflows/review/runs/run-1/stage/draft/output" download=""');
    expect(visible).toContain("Download report");
    expect(visible).toContain("What happened Rendered the report.");
    expect(html).toMatch(/data-edge-kind="target"[^>]*>render → target: papers\/alpha</);
    expect(visible).toContain("Verdict supports");
    expect(visible).toContain("Final PDF — pinned by render, verified");
    expect(html).toContain('href="/api/workflows/review/runs/run-1/pdf" target="_blank" rel="noopener"');
    expect(visible).toContain("Open final PDF (final.pdf)");
  });
});

describe("ArtifactDetail", () => {
  it("offers a download only for a passed check with content here, and explains the rest", () => {
    const ok = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata() }));
    expect(ok).toMatch(/<strong[^>]*>report\.json<\/strong>/);
    expect(text(ok)).toContain("File check Passed");
    expect(ok).toMatch(new RegExp(`href="/api/artifact/content\\?ref=${encodeURIComponent(artifactMetadata().ref)}&amp;download=1"[^>]*>Download<`));
    const lan = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata({ contentAccess: "loopback-only" }) }));
    expect(lan).toContain("run the viewer bound to localhost");
    expect(lan).not.toContain("Download");
    const dangling = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata({ health: "artifact-dangling", fileName: undefined, manifest: undefined }) }));
    expect(dangling).toMatch(/<strong[^>]*>Attached file<\/strong>/);
    expect(dangling).toContain("Attached file not found");
    expect(dangling).not.toContain("Download");
  });
});
