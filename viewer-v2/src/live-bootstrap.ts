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
 * figures. An unchanged wiki therefore never re-renders the screen, and a
 * failed poll keeps what is shown.
 */
import { useEffect, useRef, useState } from "react";
import { fetchHealth, fetchPages, type HealthPayload, type PagesEnvelope } from "./api";
import { useAsync, type AsyncState } from "./use-async";

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

/** The bootstrap state, refreshed while the tab is visible. */
export function useLiveBootstrap(): AsyncState<Bootstrap> {
  const initial = useAsync(loadBootstrap, "bootstrap");
  const [latest, setLatest] = useState<Bootstrap | null>(null);
  const signature = useRef<string | null>(null);
  if (initial.status === "ready" && signature.current === null) signature.current = bootstrapSignature(initial.data);
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState !== "visible") return;
      loadBootstrap().then((next) => {
        const nextSignature = bootstrapSignature(next);
        if (nextSignature === signature.current) return;
        signature.current = nextSignature;
        setLatest(next);
      }, () => undefined);
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (initial.status !== "ready") return initial;
  return { status: "ready", data: latest ?? initial.data };
}
