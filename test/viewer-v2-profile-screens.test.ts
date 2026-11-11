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
import { artifactMetadata, entityType, envelope, lifecycle, recordedStage, verifiedStage, workflowRun } from "./fixtures/viewer-v2-fixtures.js";

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
    expect(html).toContain('class="pipeline-profile-badge">AUTOSCI');
    expect(html).toContain("draft → review → published");
    expect(html).toContain("wiki/papers");
    expect(html).toContain("2 published · terminal");
    expect(html).toContain("1 limbo · unreachable");
    expect(html).toContain("1 page sits in limbo — not a declared `status` value at all, so the configured transitions cannot reach it.");
    expect(html).toContain("1 rejected page counted here");
    expect(html).toContain('class="pipeline-sum is-empty">—</div><div class="pipeline-gap is-clean">No stages configured');
  });

  it("lists relation and artifact types, the validation warnings, and the lint footer", () => {
    const html = renderToStaticMarkup(createElement(PipelineView, { wiki: PROFILE }));
    expect(html).toContain("<td>Cites</td><td>Papers<span class=\"pipeline-arrow\"> → </span>Papers</td><td>3 recorded links</td>");
    expect(html).toContain("<td>Report</td><td><code>report.json</code></td><td>json</td><td>pages</td>");
    expect(html).toContain("<code>field-violation</code>");
    expect(html).toContain("status is not a declared value");
    expect(html).toContain("1 rejected page still declares a lifecycle state and is counted");
    expect(html).toContain('href="#/health">See all 2 problems in Lint →');
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
    expect(html).toContain('<a class="run-title" href="#/_journey/review/run-1">review</a><span class="run-id">run-1</span>');
    expect(html).toContain("running · draft");
    expect(html).toContain("Waiting for results</span><span class=\"chip is-warn\">Waiting for approval · gate-1");
    expect(html).toContain("$ llmwiki workflow submit run-1 --kind page --entity-type papers --slug &lt;slug&gt; --body-file &lt;path&gt;");
    expect(html).toContain("$ llmwiki workflow gate approve run-1 gate-1");
    expect(html).toContain("completed · no active step");
    expect(html).toContain('<span class="chip">History</span>');
  });

  it("sends a trust gate to a re-submit, never to gate approve, and shows a broken store as a problem", () => {
    const trust = workflowRun({ awaitingGate: "trust:papers", awaitingTrustGate: true });
    const html = renderToStaticMarkup(createElement(WorkflowRuns, { payload: { runs: [trust, { runId: "(store)", classification: "blocked-by-config", problem: "run store unreadable" }] } }));
    expect(html).toContain("Write permission required · trust:papers");
    expect(html).toContain("Set LLMWIKI_TRUSTED_WRITE to grant this profile&#x27;s writes, then re-submit.");
    expect(html).not.toContain("gate approve");
    expect(html).toContain('<span class="run-title">(store)</span><span class="chip is-warn">Problem</span>');
    expect(html).toContain("run store unreadable");
    expect(nextCommands(workflowRun({ awaitingOutput: true, nextSubmitArtifactType: "report" }))).toEqual([
      "$ llmwiki workflow submit run-1 --kind artifact --artifact-type report --slug <slug> --body-file <path>",
    ]);
  });
});

describe("Journey", () => {
  it("shows a problem envelope as a visible error", () => {
    const html = renderToStaticMarkup(createElement(Journey, { body: { ...IDS, problem: "run is not readable" }, ids: IDS }));
    expect(html).toContain('role="alert">This run could not be projected: run is not readable');
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
    expect(html).toContain('class="stage-gate gate-awaiting gate-human"><span class="stage-gate-label">Human approval — awaiting approval</span>');
    expect(html).toContain("Recorded · not verified</span><span class=\"verification-reason\">Stale or invalid · pin-mismatch");
    expect(html).toContain('href="/api/workflows/review/runs/run-1/stage/draft/output" download="">Download report');
    expect(html).toContain("What happened</span><p class=\"stage-summary\">Rendered the report.");
    expect(html).toContain('data-edge-kind="target">render → target: papers/alpha');
    expect(html).toContain('class="fact-row fact-tone-success"><dt>Verdict</dt><dd>supports</dd>');
    expect(html).toContain("Final PDF — pinned by render, verified");
    expect(html).toContain('href="/api/workflows/review/runs/run-1/pdf" target="_blank" rel="noopener">Open final PDF (final.pdf)');
  });
});

describe("ArtifactDetail", () => {
  it("offers a download only for a passed check with content here, and explains the rest", () => {
    const ok = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata() }));
    expect(ok).toContain("<strong>report.json</strong>");
    expect(ok).toContain("<dt>File check</dt><dd>Passed</dd>");
    expect(ok).toContain(`href="/api/artifact/content?ref=${encodeURIComponent(artifactMetadata().ref)}&amp;download=1">Download`);
    const lan = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata({ contentAccess: "loopback-only" }) }));
    expect(lan).toContain("run the viewer bound to localhost");
    expect(lan).not.toContain("Download");
    const dangling = renderToStaticMarkup(createElement(ArtifactDetail, { metadata: artifactMetadata({ health: "artifact-dangling", fileName: undefined, manifest: undefined }) }));
    expect(dangling).toContain("<strong>Attached file</strong>");
    expect(dangling).toContain("Attached file not found");
    expect(dangling).not.toContain("Download");
  });
});
