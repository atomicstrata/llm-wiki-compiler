/**
 * llmwiki viewer — persistent header chrome renderer.
 *
 * The header (project title, verdict pill, meta line) persists across every
 * route, so `renderHeader` is called once from the bootstrap payloads in
 * viewer.js's `main()`, rather than per-route like the main pane. Split out
 * of viewer.js into its own module to keep that file under the project's
 * 400-line budget (CLAUDE.md) — this module owns nothing viewer.js needs
 * back, so the only export is `renderHeader`.
 *
 * The pill needs both bootstrap payloads: `/api/pages` carries the freshness
 * counts and the state-file status, `/api/health` the lint cache. Both are
 * already fetched at bootstrap, so neither costs a request.
 *
 * The meta line deliberately says "snapshot" rather than "compiled":
 * `updatedAt` is the viewer's snapshot-build time, not the time the wiki
 * was compiled — labelling it "compiled" would assert something that may
 * never have happened at that moment.
 */

import { formatUtcTimestamp, lintTotal, projectTitle } from "./viewer-format.js";

const TITLE_SELECTOR = "[data-app-title]";
const META_SELECTOR = "[data-app-meta]";
const VERDICT_PILL_SELECTOR = "[data-verdict]";

/**
 * The two verdicts whose wording is fixed. Tones are `.freshness-pill`
 * modifiers from viewer-chrome.css; the third verdict shares that sheet's
 * `is-unknown` tone but composes its own text (see {@link unmeasuredLabels}).
 */
const VERDICT_ATTENTION = { tone: "is-warn", text: "NEEDS ATTENTION" };
const VERDICT_CLEAR = { tone: "is-ok", text: "ALL CLEAR" };
const TONE_UNMEASURED = "is-unknown";

/** The state.json classification under which freshness is actually computable. */
const STATE_OK = "ok";

/**
 * Render the persistent header identity, verdict pill, and meta line.
 *
 * @param {object|null} envelope - The `/api/pages` bootstrap envelope.
 * @param {object|null} health - The `/api/health` payload, for its lint cache.
 */
export function renderHeader(envelope, health) {
  const titleEl = document.querySelector(TITLE_SELECTOR);
  if (titleEl) titleEl.textContent = projectTitle(envelope);
  renderVerdictPill(envelope, health?.lint ?? null);
  renderHeaderMeta(envelope);
}

/**
 * Paint the header's whole-wiki verdict pill. Stays hidden while the counts
 * are unknown — an empty envelope is not evidence of health, and a pill that
 * appeared before its inputs did would flash a verdict it had not computed.
 */
// CRAP is estimated from zero call-graph references into this module: the
// JSDOM harness (test/fixtures/viewer-jsdom.ts) evals viewer-header.js from
// source rather than importing it, so static analysis cannot see that
// test/viewer-header.test.ts exercises this via renderHeader. Not missing
// tests — see viewer-format.js for the same, earlier-established caveat.
// fallow-ignore-next-line complexity
function renderVerdictPill(envelope, lint) {
  const badge = document.querySelector(VERDICT_PILL_SELECTOR);
  if (!badge || !envelope?.counts) return;
  const { tone, text } = wikiVerdict(envelope, lint);
  badge.hidden = false;
  badge.className = `freshness-pill ${tone}`;
  badge.textContent = text;
}

/**
 * Decide the whole-wiki verdict: what the pill reads and how it is toned.
 *
 * Precedence, highest first:
 *   1. Attention — something measured is wrong (lint findings, stale or
 *      orphaned pages, profile collector problems).
 *   2. Unmeasured — a check could not run at all, so its result is unknown.
 *   3. Clear — everything was measured and nothing is wrong.
 *
 * Attention deliberately outranks unmeasured: a wiki with known errors AND
 * freshness that could not be computed is attention-worthy, not merely
 * unknown, and reporting the weaker fact would bury the stronger one.
 *
 * Profile collector problems sit in rule 1 — NOT rule 2 — for that same
 * reason. A malformed entity directory or an invalid entity page is a
 * measured, confirmed defect; the collector ran and found it. It is only
 * carried on the envelope when non-empty, and the whole block is absent for a
 * default-profile project, so absence stays exactly what it was before this
 * input existed: not evidence of anything.
 *
 * Rule 2 exists because the freshness-only pill this replaced could not tell
 * the two zeroes apart. A missing or corrupt state.json makes every page
 * `unverified`, which leaves `stale` and `orphaned` both 0 — and the old pill
 * read those as "ALL PAGES FRESH", asserting health nothing had measured,
 * directly under a meta line that said "state missing".
 *
 * DELIBERATE DIVERGENCE from `Direction - Nebula.dc.html`, which the Overview
 * was pixel-matched to and whose header pill reads a teal "ALL PAGES FRESH".
 * The newer health mockup (`docs/superpowers/specs/2026-08-05-nebula-health-
 * tree.txt`, line 96) puts "NEEDS ATTENTION" in that same shared header, and
 * its own change note argues the case: "'All pages fresh' was true but
 * misleading with 102 errors open. The header pill now reports the *whole*
 * verdict." Where the two design files disagree the newer one wins, and the
 * header is shared — so the Overview now often reads "NEEDS ATTENTION" too.
 * That is intended and user-approved, not a fidelity regression; a later
 * fidelity pass must not "restore" the freshness-only pill.
 */
function wikiVerdict(envelope, lint) {
  const findings = lintTotal(lint);
  if (isAttentionWorthy(envelope.counts, findings, profileProblemCount(envelope))) {
    return VERDICT_ATTENTION;
  }
  const unmeasured = unmeasuredLabels(envelope.stateStatus, findings);
  if (unmeasured.length === 0) return VERDICT_CLEAR;
  return { tone: TONE_UNMEASURED, text: unmeasured.join(" · ") };
}

/**
 * True when anything the wiki actually measured is actionable. Warnings count
 * alongside errors so the pill cannot contradict the sidebar's lint badge,
 * which totals both.
 *
 * A null or absent figure compares false against 0, which is exactly what
 * this wants: a count that was never measured is not evidence of a problem —
 * {@link unmeasuredLabels} is what speaks for those.
 */
function isAttentionWorthy(counts, findings, profileProblems) {
  return [findings, counts.stale, counts.orphaned, profileProblems].some((count) => count > 0);
}

/**
 * How many problems the profile collector reported.
 *
 * `profileProblems` is a CAPPED list, so `profileProblemTotal` — the true
 * count — is read first; the list length is only a fallback for a payload that
 * somehow carried one without the other. A default-profile project sends
 * neither key, and 0 is the correct reading of that: absent means the collector
 * had nothing to report, not that it never ran.
 */
function profileProblemCount(envelope) {
  return envelope.profileProblemTotal ?? envelope.profileProblems?.length ?? 0;
}

/**
 * Name each check that never produced a result: freshness needs a readable
 * state.json, lint needs a run to have happened (`lintTotal` returns null for
 * exactly that, which is why it is not re-derived here). An empty list means
 * the verdict rests on real measurements and may safely read all-clear.
 */
function unmeasuredLabels(stateStatus, findings) {
  const labels = [];
  if (stateStatus !== STATE_OK) labels.push("FRESHNESS UNVERIFIED");
  if (findings === null) labels.push("LINT NEVER RUN");
  return labels;
}

/**
 * Render the header meta line. Deliberately says "snapshot" rather than
 * "compiled": `updatedAt` is the viewer's snapshot-build time, not the
 * time the wiki was compiled.
 */
// Same call-graph blind spot as renderVerdictPill above — see that
// function's comment.
// fallow-ignore-next-line complexity
function renderHeaderMeta(envelope) {
  const meta = document.querySelector(META_SELECTOR);
  if (!meta) return;
  const parts = [
    `${envelope?.profileId ?? "default"} project`,
    `Viewer loaded at ${formatUtcTimestamp(envelope?.updatedAt)}`,
  ];
  if (envelope?.stateStatus !== STATE_OK) parts.push("Update status unavailable: compilation tracking data is missing or unreadable");
  meta.textContent = parts.join(" · ");
  meta.title = `Snapshot: ${envelope?.updatedAt ?? "unknown"}; profile: ${envelope?.profileId ?? "default"}; state: ${envelope?.stateStatus ?? "unknown"}`;
}
