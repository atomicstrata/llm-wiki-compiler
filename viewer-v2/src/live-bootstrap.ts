/**
 * The shell's two bootstrap payloads, `/api/pages` and `/api/health`, kept
 * live. They load once, then reload every half minute while the tab is
 * visible and again whenever it becomes visible, so a compile, a lint run or
 * a new review candidate shows up without a reload. The server rebuilds its
 * snapshot lazily on a request, so a change reaches the client on the poll
 * after it lands, which is well inside the half minute.
 *
 * A reload replaces the data only when its signature moved: page count, the
 * newest page timestamp, the counts, the state, and the lint and review
 * figures. An unchanged wiki therefore keeps the same state object and never
 * re-renders the screen. A failed reload keeps what is shown; a failed first
 * load shows the error until a later reload succeeds.
 */
import { useEffect, useState } from "react";
import { fetchHealth, fetchPages, type HealthPayload, type PagesEnvelope } from "./api";
import type { AsyncState } from "./use-async";

/** How often a visible tab checks for a new compile. */
const REFRESH_MS = 30_000;

/** The bootstrap payloads; health is null when its fetch fails. */
export interface Bootstrap {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
}

/** Load both payloads; a failed health fetch only degrades the surfaces that need it. */
async function loadBootstrap(): Promise<Bootstrap> {
  const [wiki, health] = await Promise.all([fetchPages(), fetchHealth().catch(() => null)]);
  return { wiki, health };
}

/** A string that changes whenever anything the screens show from the payloads would. */
export function bootstrapSignature({ wiki, health }: Bootstrap): string {
  const newest = wiki.pages.reduce((latest, page) => (page.updatedAt > latest ? page.updatedAt : latest), "");
  return JSON.stringify([wiki.pages.length, newest, wiki.counts, wiki.stateStatus, health?.lint ?? null, health?.pendingReviews ?? null]);
}

/** The state after a successful load: the previous one, untouched, when nothing shown would change. */
export function nextBootstrapState(previous: AsyncState<Bootstrap>, next: Bootstrap): AsyncState<Bootstrap> {
  const unchanged = previous.status === "ready" && bootstrapSignature(previous.data) === bootstrapSignature(next);
  return unchanged ? previous : { status: "ready", data: next };
}

/** The state after a failed load: whatever is shown stays; only a first load reports the failure. */
function failedBootstrapState(previous: AsyncState<Bootstrap>, error: unknown): AsyncState<Bootstrap> {
  if (previous.status === "ready") return previous;
  return { status: "error", message: error instanceof Error ? error.message : String(error) };
}

/** The bootstrap state, refreshed while the tab is visible. */
export function useLiveBootstrap(): AsyncState<Bootstrap> {
  const [state, setState] = useState<AsyncState<Bootstrap>>({ status: "loading" });
  useEffect(() => {
    const load = (): void => {
      loadBootstrap().then(
        (next) => setState((previous) => nextBootstrapState(previous, next)),
        (error: unknown) => setState((previous) => failedBootstrapState(previous, error)),
      );
    };
    const refresh = (): void => {
      if (document.visibilityState === "visible") load();
    };
    load();
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return state;
}
