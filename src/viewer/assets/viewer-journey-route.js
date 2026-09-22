/**
 * Workflow detail routing layered onto the public viewer's typed-page router.
 * Fetches live verification per visit. A response from an abandoned navigation
 * cannot paint over the newly selected page, even when the operator returns.
 */
import { renderJourney } from "./viewer-journey.js";

let navigation = 0;

/** Invalidate outstanding journey responses on every navigation. */
export function invalidateJourneyNavigation() {
  navigation += 1;
}

/** Parse exact journey routes before the public generic page route. */
export function journeyRoute(hash) {
  const match = /^#\/workflows\/([^/]+)\/runs\/([^/]+)$/.exec(hash);
  if (!match) return undefined;
  try {
    return { kind: "journey", workflow: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]) };
  } catch {
    return { kind: "home" };
  }
}

/** Load a run with visible progress; never carry verified facts through an error. */
export async function renderJourneyRoute(main, route) {
  const visit = navigation;
  const hash = location.hash;
  main.replaceChildren();
  const pending = document.createElement("p");
  pending.setAttribute("role", "status");
  pending.textContent = "Verifying retained workflow records…";
  main.appendChild(pending);
  const endpoint = "/api/workflows/" + encodeURIComponent(route.workflow) +
    "/runs/" + encodeURIComponent(route.runId);
  const body = await fetchJourneyProjection(endpoint);
  if (visit === navigation && hash === location.hash) renderJourney(main, body, route);
}

/** A failed verification read always replaces prior facts with a problem panel. */
async function fetchJourneyProjection(endpoint) {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error("Workflow records are unavailable.");
    return await response.json();
  } catch {
    return { problem: "Workflow records could not be verified. Reopen this run to retry." };
  }
}
