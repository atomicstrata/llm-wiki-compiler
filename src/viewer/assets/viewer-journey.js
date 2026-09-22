/**
 * @file viewer-journey.js
 * llmwiki viewer — the generic workflow-journey timeline client.
 *
 * Renders a workflow run's stage timeline, human-approval gate lifecycle,
 * verified "what happened" facts, and per-stage artifact
 * download links over the P9.1 per-run projection + the P9.3 artifact route.
 *
 * CSP-STRICT: every node is built with `document.createElement` and every
 * provider/run-controlled value is written via `textContent` — NEVER
 * `innerHTML`, `insertAdjacentHTML`, or inline handlers. Every URL path
 * segment is `encodeURIComponent`-encoded before it enters an href. There is
 * A verified PDF may use a sandboxed same-origin iframe: `frame-ancestors`
 * controls who may frame the viewer, while the pinned policy permits this
 * viewer to frame its own artifact route. A download link remains available.
 *
 * The module is workflow-GENERIC: it renders whatever the projection returns
 * (verified via a product provider, recorded-only via plain `llmwiki view`)
 * with a separately isolated presentation adapter for archived providers.
 */

import { buildVerifiedStageFacts } from "./viewer-stage-facts.js";
import { buildExperimentPanel } from "./viewer-experiment-compat.js";

/** Human-readable labels for each run classification the projection can carry. */
const CLASSIFICATION_LABELS = {
  "current": "Current",
  "needs-adaptation": "Needs adaptation",
  "blocked-by-config": "Blocked by config",
  "historical": "Historical",
};

/** Gate-state → human phrase; membership also gates the state's CSS modifier. */
const GATE_STATE_TEXT = {
  "not-reached": "not reached",
  "awaiting": "awaiting approval",
  "approved": "approved",
};

/**
 * Render the per-run workflow journey into `main`, or a visible error panel
 * when the response is a problem envelope / not a valid projection.
 *
 * @param {HTMLElement} main - The main pane to render into (cleared first).
 * @param {unknown} projection - The `/api/workflows/:wf/runs/:run` body.
 * @param {{workflow: string, runId: string}} ctx - The route's ids, for links.
 */
export function renderJourney(main, projection, ctx) {
  main.innerHTML = "";
  main.className = "main-pane journey-pane";
  if (!isRenderableProjection(projection)) {
    main.appendChild(buildJourneyError(projection, ctx));
    return;
  }
  main.appendChild(buildHeading("h1", `Run ${stringOr(projection.runId, ctx.runId)}`));
  main.appendChild(buildClassificationBanner(projection.classification));
  appendChildIfPresent(main, buildLiveNotice(projection.live));
  appendChildIfPresent(main, buildExperimentPanel(projection.stages));
  main.appendChild(buildStageTimeline(projection.stages, ctx));
}

/** A renderable projection carries a `stages` ARRAY and no problem/error field. */
function isRenderableProjection(body) {
  if (!isObject(body)) return false;
  if (hasProblemField(body)) return false;
  return Array.isArray(body.stages);
}

/** True when `value` is a non-null object. */
function isObject(value) {
  return !!value && typeof value === "object";
}

/** True when a projection body carries a fail-visible problem/error field. */
function hasProblemField(body) {
  return "problem" in body || "error" in body;
}

/** Build the visible error panel for a problem envelope / malformed body. */
function buildJourneyError(body, ctx) {
  const wrap = document.createElement("div");
  wrap.className = "journey-error warning-banner";
  const problem = problemMessage(body);
  wrap.textContent = isNonEmptyString(problem)
    ? `This run could not be projected: ${problem}`
    : `Run ${ctx.workflow}/${ctx.runId} returned no timeline.`;
  return wrap;
}

/** Extract the problem/error message from a body, or null when it carries none. */
function problemMessage(body) {
  if (!isObject(body)) return null;
  return body.problem ?? body.error ?? null;
}

/** Build the prominent run-classification banner. */
function buildClassificationBanner(classification) {
  const known = CLASSIFICATION_LABELS[classification];
  const el = document.createElement("div");
  el.className = `journey-classification classification-${known ? classification : "unknown"}`;
  el.textContent = `Run status: ${known || stringOr(classification, "unknown")}`;
  return el;
}

/** Notices keyed by the envelope's `live.outcome`; an applied provider needs none. */
const LIVE_NOTICES = {
  "timed-out": (live) => `Live verification timed out after ${liveBudgetText(live)}; showing the recorded run. `
    + "Ask the viewer host to increase its configured projection timeout.",
  degraded: () => "Live verification was unavailable (the provider failed or returned an unusable result); showing the recorded run.",
  drifted: () => "The run changed while it was being verified; showing the recorded run. Reload to verify again.",
};

/** Why a verified journey is showing recorded-only, said plainly — or null when nothing needs saying. */
function buildLiveNotice(live) {
  if (!isObject(live) || !Object.prototype.hasOwnProperty.call(LIVE_NOTICES, live.outcome)) return null;
  const el = document.createElement("p");
  el.className = `journey-live-notice live-${live.outcome}`;
  el.textContent = LIVE_NOTICES[live.outcome](live);
  return el;
}

function liveBudgetText(live) {
  const ms = Number(live.timeoutMs);
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 1000)} s` : "its budget";
}

/** Build the ordered stage timeline in roster order. */
function buildStageTimeline(stages, ctx) {
  const list = document.createElement("ol");
  list.className = "journey-timeline";
  for (const stage of stages) list.appendChild(buildStageItem(stage || {}, ctx));
  return list;
}

/** Build one stage row with any human gate first, then facts and artifacts. */
function buildStageItem(stage, ctx) {
  const li = document.createElement("li");
  li.className = "journey-stage";
  if (isNonEmptyString(stage.stageId)) li.dataset.stageId = stage.stageId;
  appendChildIfPresent(li, buildGateCallout(stage.gate));
  li.appendChild(buildStageHeader(stage));
  li.appendChild(buildVerificationBadge(stage));
  appendChildIfPresent(li, buildVerificationReason(stage));
  li.appendChild(buildVerifiedStageFacts(stage));
  appendChildIfPresent(li, buildArtifactLink(stage, ctx));
  appendChildIfPresent(li, buildPdfPanel(stage, ctx));
  return li;
}

/**
 * Build the always-present verification badge. A stage is labelled "Verified" ONLY
 * when `verification === "verified"` EXACTLY; every other row (recorded-only, unknown,
 * fact-shaped-but-unverified) is labelled "Recorded · not verified", so a recorded row
 * is never silently indistinguishable from a verified one that merely lacks a summary.
 */
function buildVerificationBadge(stage) {
  const verified = stage.verification === "verified";
  const badge = buildSpan("journey-verification", verified ? "Verified" : "Recorded · not verified");
  badge.classList.add(verified ? "verification-verified" : "verification-recorded");
  return badge;
}

/** Build a visible stable reason under the recorded-only umbrella. */
function buildVerificationReason(stage) {
  if (stage.verification === "verified" || !stage.verificationReason) return null;
  const category = stage.verificationReason.category, code = stage.verificationReason.code;
  if (![Boolean(VERIFICATION_REASON_LABELS[category]), /^[a-z][a-z0-9-]{0,63}$/.test(code)].every(Boolean)) return null;
  const reason = buildSpan("journey-verification-reason", `${VERIFICATION_REASON_LABELS[category]} · ${code}`);
  reason.dataset.verificationCategory = category;
  reason.dataset.verificationCode = code;
  return reason;
}

/** Stable visible labels for recorded-only reason categories. */
const VERIFICATION_REASON_LABELS = {
  "stale-or-invalid": "Stale or invalid",
  "unavailable": "Unavailable",
  "timed-out": "Timed out",
};

/** Append `child` to `parent` when it was actually built (non-null). */
function appendChildIfPresent(parent, child) {
  if (child) parent.appendChild(child);
}

/** Build the stage's id + status header row. */
function buildStageHeader(stage) {
  const header = document.createElement("div");
  header.className = "journey-stage-header";
  header.appendChild(buildSpan("journey-stage-id", stringOr(stage.stageId, "(unnamed stage)")));
  header.appendChild(buildSpan("journey-stage-status", stringOr(stage.status, "unknown")));
  return header;
}

/** Build the gate-lifecycle callout, or null when the stage declares no gate. */
function buildGateCallout(gate) {
  if (!gate || typeof gate !== "object") return null;
  const state = stringOr(gate.state, "unknown");
  const wrap = document.createElement("div");
  wrap.className = `journey-gate gate-${GATE_STATE_TEXT[state] ? state : "unknown"}`;
  markHumanGate(wrap, gate);
  wrap.appendChild(buildGateLabel(gate, state));
  appendChildIfPresent(wrap, buildGateByline(gate));
  return wrap;
}

/** Add the prominence hook only to gates whose recorded kind is human. */
function markHumanGate(wrap, gate) {
  if (gate.gateKind === "human") wrap.classList.add("journey-gate-human");
}

/** Build the gate label, naming a HUMAN gate distinctly from agent/trust gates. */
function buildGateLabel(gate, state) {
  const kind = gate.gateKind === "human"
    ? "Human approval"
    : `${titleCase(stringOr(gate.gateKind, "gate"))} gate`;
  return buildSpan("journey-gate-label", `${kind} — ${GATE_STATE_TEXT[state] || state}`);
}

/**
 * Build the approval byline, shown ONLY when the projection actually recorded
 * one. A satisfied gate with no gate-approved event omits every field, so this
 * returns null rather than inventing an approver.
 */
function buildGateByline(gate) {
  const parts = GATE_BYLINE_FIELDS
    .filter(([key]) => isNonEmptyString(gate[key]))
    .map(([key, format]) => format(gate[key]));
  if (parts.length === 0) return null;
  return buildSpan("journey-gate-byline", parts.join(" "));
}

/** Ordered byline fields: [key, formatter] — each rendered only when present. */
const GATE_BYLINE_FIELDS = [
  ["actor", (v) => `by ${v}`],
  ["actorKind", (v) => `(${v})`],
  ["at", (v) => `at ${v}`],
  ["decision", (v) => `— ${v}`],
  ["subjectDigest", (v) => `subject ${abbreviateDigest(v)}`],
];

/** Keep an approval digest recognizable without letting it dominate the gate. */
function abbreviateDigest(value) {
  return value.length > 19 ? `${value.slice(0, 19)}…` : value;
}

/**
 * Build the per-stage artifact download link to the P9.3 route, or null when
 * the stage recorded no output. Every segment is `encodeURIComponent`-encoded;
 * there is NO iframe — the artifact response's `frame-ancestors 'none'`
 * forbids every embedding ancestor, including this same-origin viewer.
 */
function buildArtifactLink(stage, ctx) {
  if (!stage.outputRef || typeof stage.outputRef !== "object") return null;
  if (!isNonEmptyString(stage.stageId)) return null;
  const p = document.createElement("p");
  p.className = "journey-artifact";
  const a = document.createElement("a");
  a.className = "journey-artifact-link";
  a.href = stageOutputPath(ctx.workflow, ctx.runId, stage.stageId);
  a.setAttribute("download", "");
  a.textContent = `Download ${stringOr(stage.outputRef.artifactType, "artifact")}`;
  p.appendChild(a);
  return p;
}

/** A pdfRef is well-formed when every field is a non-empty string and the digest is `sha256:<64 hex>`. */
const PDF_CONTENT_ADDRESS = /^sha256:[0-9a-f]{64}$/;
function isWellFormedPdfRef(ref) {
  if (!isObject(ref)) return false;
  const named = [ref.artifactType, ref.slug, ref.member].every(isNonEmptyString);
  return named && PDF_CONTENT_ADDRESS.test(String(ref.sha256));
}

/**
 * Build the "Final PDF" panel for a stage that is VERIFIED and carries a well-formed
 * `pdfRef` — the same suppression the provenance rows apply, so a recorded-only row can
 * never show a trusted-looking PDF. The same-origin iframe embeds the P9.6 route, whose
 * response carries `frame-ancestors 'self'`; the link serves browsers that do not inline PDFs.
 */
function buildPdfPanel(stage, ctx) {
  if (stage.verification !== "verified" || !isWellFormedPdfRef(stage.pdfRef)) return null;
  if (!isNonEmptyString(stage.stageId)) return null;
  const section = document.createElement("section");
  section.className = "journey-pdf";
  const heading = document.createElement("h4");
  heading.className = "journey-pdf-heading";
  heading.textContent = `Final PDF — pinned by ${stage.stageId}, verified`;
  section.appendChild(heading);
  const a = document.createElement("a");
  a.className = "journey-pdf-link";
  a.href = pdfPath(ctx.workflow, ctx.runId);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = `Open final PDF (${stage.pdfRef.member})`;
  section.appendChild(a);
  const frame = document.createElement("iframe");
  frame.className = "journey-pdf-frame";
  frame.src = pdfPath(ctx.workflow, ctx.runId);
  frame.title = "Final PDF";
  section.appendChild(frame);
  return section;
}

/** Build the P9.6 `/api/workflows/:wf/runs/:run/pdf` URL, encoded. */
function pdfPath(workflow, runId) {
  return `/api/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}/pdf`;
}

/** Build the P9.3 `/api/workflows/:wf/runs/:run/stage/:stage/output` URL, encoded. */
function stageOutputPath(workflow, runId, stageId) {
  return `/api/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}` +
    `/stage/${encodeURIComponent(stageId)}/output`;
}


/** Build an element with the given tag and text content. */
function buildHeading(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

/** Build a `<span>` with a class and text content. */
function buildSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/** Build a `<li>` with a class and text content. */
function buildListItem(className, text) {
  const li = document.createElement("li");
  li.className = className;
  li.textContent = text;
  return li;
}

/** True when `value` is a non-empty string. */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** `value` when it is a non-empty string, else `fallback`. */
function stringOr(value, fallback) {
  return isNonEmptyString(value) ? value : fallback;
}

/** Capitalize the first letter of a short token for a label. */
function titleCase(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
