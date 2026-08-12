/**
 * llmwiki viewer — the #/workflows list route.
 *
 * A peer of #/reviews: same `.list-row` language, same empty-state contract,
 * and the same reason for living outside viewer-lists.js — the routes there all
 * render from the already-fetched /api/pages envelope, while workflow runs live
 * under `.llmwiki/workflows/runs/`, outside the frozen snapshot, so this route
 * is fed by a per-visit /api/workflow-runs fetch.
 *
 * The route exists for the PARKED runs. A run waiting on a gate approval or a
 * stage-output submission is a work item blocked on a human; a run that is
 * merely running or completed needs nothing. So a parked row is marked as such
 * on the row itself and names the CLI command that moves it. Naming a command
 * is as far as this goes: the viewer is a read-only snapshot with no write path,
 * and a button implying otherwise would be a lie.
 *
 * The command has to be the one that WORKS, which is why the row branches on the
 * classifier's hint fields rather than on the park flags alone: a stage-output
 * park names the declared `--kind`/type it submits against, and a `trust:` gate
 * — which no `gate approve` can clear — names the trusted-write grant instead. A
 * command that fails on paste is worse than none, at the moment a reader is
 * least able to tell why.
 *
 * A `problem` row (an unavailable or malformed run store) renders AS a problem.
 * The endpoint deliberately reports a broken store as a fail-visible row rather
 * than an empty list — dropping it here, or dressing it as a normal run, would
 * undo that and let a broken store read as "no runs".
 */

import { el, emptyState, heading } from "./viewer-dom.js";

/**
 * Human wording for the classifications worth stating (see
 * `src/workflows/status.ts`). `current` is deliberately absent: it is the
 * unremarkable default relationship to the active profile, and a chip on every
 * healthy row would bury the two that mean the run cannot be acted on. An
 * unknown classification falls through to its raw value, so one added later is
 * visible-but-ugly rather than silently invisible.
 */
const CLASSIFICATION_LABELS = {
  historical: "History",
  "needs-adaptation": "Needs adaptation",
  "blocked-by-config": "Blocked by config",
};

/** Shown in place of the stage id when a run sits on no stage (e.g. a finished run). */
const NO_STAGE = "no stage";

/**
 * Placeholder for a submit hint whose stage declares no write entity type. The
 * server sends `nextSubmitEntityType` whenever the stage declares one, so this
 * appears only for a stage that declares none — and an angle-bracketed
 * placeholder says "you supply this" where a silently missing flag would leave a
 * command that fails on paste. Same wording as the CLI's `submitCommand`.
 */
const ENTITY_TYPE_PLACEHOLDER = "<entity-type>";

/** The flags every `workflow submit` needs beyond its kind-specific target. */
const SUBMIT_TAIL = "--slug <slug> --body-file <path>";

/**
 * What a `trust:` gate actually needs. A trust gate is NOT cleared by
 * `gate approve` — `vouchGate` throws `TrustGateNotHereError` for exactly that
 * call. The Trust Guard clears it on a successful write, so the operator grants
 * the profile's writes and re-submits the SAME run.
 */
const TRUST_GATE_NOTE =
  "This write is trust-gated: `gate approve` cannot clear it. " +
  "Set LLMWIKI_TRUSTED_WRITE to grant this profile's writes, then re-submit.";

/**
 * The command that lists what the active profile declares. It is the right
 * first command for BOTH readings of an empty list — a profile with no
 * workflows at all (the common one; the default profile declares none) and a
 * profile whose workflows have simply never been run.
 */
const WORKFLOW_LIST_COMMAND = "$ llmwiki workflow list";

/**
 * Render the workflow-runs route from an `/api/workflow-runs` payload.
 *
 * @param {HTMLElement} main - The main pane to render into.
 * @param {{runs?: unknown[]}} payload - The `/api/workflow-runs` envelope.
 */
export function renderWorkflowRunsList(main, payload) {
  const runs = runsIn(payload);
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Workflows"));
  const body = el("div", "list-body");
  main.appendChild(body);
  if (runs.length === 0) {
    body.appendChild(emptyWorkflowsState());
    return;
  }
  for (const run of runs) body.appendChild(buildRunRow(run));
}

/** The rows in an `/api/workflow-runs` envelope, defended against a malformed payload. */
function runsIn(payload) {
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

/**
 * Empty state for a project with no runs. Most projects have none — workflows
 * are a Configurable Lifecycle Profile feature and the default profile declares
 * none — so this is a normal, common state, not a failure, and it gets the
 * teaching card rather than the italic loading placeholder.
 */
function emptyWorkflowsState() {
  return emptyState(
    "No workflow runs",
    "Workflows are the staged pipelines a profile declares — each run advances through them, parking whenever it needs a human to approve a gate or submit a stage output.",
    WORKFLOW_LIST_COMMAND,
  );
}

/** True when the row describes an unavailable or malformed run store, not a run. */
function isProblemRow(run) {
  return typeof run?.problem === "string" && run.problem.length > 0;
}

/** True when the run is blocked on a human — a gate approval or a stage output. */
function isParked(run) {
  return typeof run?.awaitingGate === "string" || run?.awaitingOutput === true;
}

/** Build one row, dispatching on whether it reports a run or a broken store. */
function buildRunRow(run) {
  if (isProblemRow(run)) return buildProblemRow(run);
  const row = el("div", `list-row workflow-row${isParked(run) ? " is-parked" : ""}`);
  row.appendChild(buildRunHead(run));
  row.appendChild(el("p", "workflow-meta", runMetaText(run)));
  const flags = buildRunFlags(run);
  if (flags) row.appendChild(flags);
  appendNextCommands(row, run);
  return row;
}

/**
 * Head line: the workflow the run belongs to, plus the run id. The workflow is
 * the title because it is what the reader recognises; the id is what the CLI
 * commands below take, so it sits beside it in mono rather than being hidden.
 */
function buildRunHead(run) {
  const head = el("div", "workflow-head");
  head.appendChild(el("span", "list-title", workflowNameOf(run)));
  head.appendChild(el("span", "workflow-run-id", String(run.runId ?? "")));
  return head;
}

/**
 * The workflow id, or a plain statement when the row carries none. A readable
 * run always names its workflow; a row without one is malformed, and an empty
 * title line would read as a rendering bug rather than as missing data.
 */
function workflowNameOf(run) {
  const workflow = typeof run.workflow === "string" ? run.workflow.trim() : "";
  return workflow.length > 0 ? workflow : "Unknown workflow";
}

/** Meta line: lifecycle status and the stage the run currently sits on. */
function runMetaText(run) {
  const status = typeof run.status === "string" && run.status.length > 0 ? run.status : "unknown";
  return `${status} · ${stageTextOf(run)}`;
}

/** The current stage id, or the no-stage wording when the run sits on none. */
function stageTextOf(run) {
  const stage = typeof run.currentStage === "string" ? run.currentStage.trim() : "";
  return stage.length > 0 ? stage : NO_STAGE;
}

/**
 * Build the chip row. Returns null when there is nothing to say, so an
 * ordinary running row does not carry an empty strip.
 */
function buildRunFlags(run) {
  const labels = flagLabels(run);
  if (labels.length === 0) return null;
  const wrap = el("div", "workflow-flags");
  for (const { text, parked } of labels) wrap.appendChild(buildFlag(text, parked));
  return wrap;
}

/**
 * The chips a run earns, in reading order: what it is parked on, then how it
 * relates to the active profile when that is worth stating.
 */
function flagLabels(run) {
  const parked = parkLabels(run).map((text) => ({ text, parked: true }));
  const classification = CLASSIFICATION_LABELS[run.classification];
  return classification ? [...parked, { text: classification, parked: false }] : parked;
}

/** One chip. A parked chip takes the warn treatment; anything else is neutral. */
function buildFlag(text, parked) {
  return el("span", `workflow-flag${parked ? " is-parked" : ""}`, text);
}

/**
 * The parked states, in the order they must be cleared: a stage output is
 * submitted before the gate guarding that stage can be approved, so a run
 * carrying both reads top-to-bottom as the sequence of work it needs.
 *
 * A `trust:` gate is named as one. It parks the run exactly like a human/agent
 * gate but is cleared by a different act entirely, and a chip that called both
 * "Awaiting gate" would send the reader to the command that fails.
 */
function parkLabels(run) {
  const labels = [];
  if (run.awaitingOutput === true) labels.push("Awaiting stage output");
  if (typeof run.awaitingGate === "string") labels.push(gateLabel(run));
  return labels;
}

/** The chip text for a gate park, distinguishing a trust gate from an approvable one. */
function gateLabel(run) {
  const kind = run.awaitingTrustGate === true ? "Trust gate" : "Awaiting gate";
  return `${kind} · ${run.awaitingGate}`;
}

/**
 * Append the unpark guidance: the trust-gate note when one applies, then one
 * command line per parked state. Text only, never a control: this viewer cannot
 * mutate a run, and the row must not imply that it can.
 */
function appendNextCommands(row, run) {
  if (run.awaitingTrustGate === true) row.appendChild(el("p", "workflow-note", TRUST_GATE_NOTE));
  for (const command of nextCommands(run)) {
    row.appendChild(el("p", "workflow-next", command));
  }
}

/**
 * The unpark commands for a run, in the same order as {@link parkLabels} and
 * matching what the CLI's own `next:` hint prints (`workflow-shared.ts`).
 *
 * Two branches are load-bearing rather than cosmetic. `workflow submit` needs
 * `--kind` before anything else — `buildStageOutput` requires it first — so the
 * declared submit target the server sends is spelled out rather than left to the
 * reader. And a `trust:` gate gets a submit line and NO `gate approve` line:
 * that approval throws, and the re-submit the note describes is the act that
 * clears the gate.
 */
function nextCommands(run) {
  const runId = String(run.runId ?? "");
  const commands = [];
  if (needsSubmit(run)) commands.push(`$ ${submitCommand(run, runId)}`);
  if (needsGateApproval(run)) {
    commands.push(`$ llmwiki workflow gate approve ${runId} ${run.awaitingGate}`);
  }
  return commands;
}

/**
 * True when the run needs a `workflow submit`: it is parked for a stage output,
 * or parked on a trust gate — which the Trust Guard clears on the next
 * successful write, i.e. on a re-submission of the same run.
 */
function needsSubmit(run) {
  return run.awaitingOutput === true || run.awaitingTrustGate === true;
}

/** True when the run is parked on a gate `gate approve` can actually clear. */
function needsGateApproval(run) {
  return typeof run.awaitingGate === "string" && run.awaitingTrustGate !== true;
}

/**
 * The concrete `workflow submit` for a write-park. A stage declaring an artifact
 * write and no entity write submits `--kind artifact`; every other write-park
 * submits `--kind page`. Mirrors the CLI's `submitCommand` so the two surfaces
 * never print different commands for the same parked run.
 */
function submitCommand(run, runId) {
  const base = `llmwiki workflow submit ${runId}`;
  const entityType = run.nextSubmitEntityType;
  if (typeof entityType !== "string" && typeof run.nextSubmitArtifactType === "string") {
    return `${base} --kind artifact --artifact-type ${run.nextSubmitArtifactType} ${SUBMIT_TAIL}`;
  }
  const target = typeof entityType === "string" ? entityType : ENTITY_TYPE_PLACEHOLDER;
  return `${base} --kind page --entity-type ${target} ${SUBMIT_TAIL}`;
}

/**
 * Build a problem row: the run (or store) the trouble is attributed to, and why
 * it could not be read. No status, stage, or unpark command — the row describes
 * something unreadable, and inventing lifecycle fields for it would present a
 * broken store as a working run.
 */
function buildProblemRow(run) {
  const row = el("div", "list-row workflow-row is-problem");
  const head = el("div", "workflow-head");
  head.appendChild(el("span", "list-title", String(run.runId ?? "Unknown run")));
  head.appendChild(el("span", "workflow-flag is-problem", "Problem"));
  row.appendChild(head);
  row.appendChild(el("p", "workflow-problem", run.problem));
  return row;
}
