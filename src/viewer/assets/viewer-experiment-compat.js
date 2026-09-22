/**
 * @file viewer-experiment-compat.js
 * @description Presentation-only compatibility for existing scientific providers.
 * Kept separate from the generic stage-fact renderer. It preserves the historical
 * panel markup and reads verified rows only; it never decides process state.
 */

/** Compatibility panel for older providers; never infer facts from stage ids. */
export function buildExperimentPanel(stages) {
  const verified = [...stages].reverse().map(verifiedExperimentState).find(Boolean);
  if (!verified) return null;
  const panel = document.createElement("section");
  panel.className = "journey-experiment";
  const heading = document.createElement("h2");
  heading.textContent = "Experiment state";
  panel.appendChild(heading);
  appendExperimentFact(panel, "hypothesis", "Hypothesis", verified.hypothesis);
  appendExperimentFact(panel, "slug", "Experiment", verified.slug);
  appendExperimentFact(panel, "lifecycle", "Lifecycle", experimentLifecycleText(verified));
  return panel;
}

/** Return a verified row's minimum closed experiment-fact shape, else null. */
function verifiedExperimentState(stage) {
  const safeStage = Object(stage);
  const facts = Object(safeStage.experimentState);
  const valid = [safeStage.verification === "verified", isNonEmptyString(facts.hypothesis),
    isNonEmptyString(facts.slug), isNonEmptyString(facts.lifecycle)].every(Boolean);
  return valid ? safeStage.experimentState : null;
}

/** Render a verified lifecycle and its optional judged verdict. */
function experimentLifecycleText(state) {
  if (state.lifecycle !== "judged" || !isNonEmptyString(state.verdict)) return state.lifecycle;
  return `${state.lifecycle}: ${state.verdict}`;
}

/** Append one already verified experiment fact with its existing proof label. */
function appendExperimentFact(panel, key, label, value) {
  const row = document.createElement("p");
  row.className = "journey-experiment-fact";
  row.dataset.experimentField = key;
  row.appendChild(buildSpan("journey-experiment-label", `${label}: `));
  row.appendChild(document.createTextNode(value));
  row.appendChild(buildSpan("journey-experiment-proof", "Verified"));
  panel.appendChild(row);
}

/** Build a literal-text span, preserving compatibility class names. */
function buildSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/** True for a non-empty string. */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
