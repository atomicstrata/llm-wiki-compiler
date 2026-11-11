/**
 * The current hash route, with a short cross-fade between screens.
 *
 * A hash change is applied inside `document.startViewTransition`, flushed
 * synchronously so the browser snapshots the new screen, which is how the
 * View Transitions API animates a single-page app. Browsers without the API,
 * and readers who ask for reduced motion, get the plain update. Every route
 * change scrolls to the top, as a new page would.
 */
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { parseRoute, type Route } from "./route";

/** Whether to animate a route change: the API exists and the reader has not asked for less motion. */
export function shouldAnimateRoutes(doc: Pick<Document, "startViewTransition"> | undefined, reduceMotion: boolean): boolean {
  return typeof doc?.startViewTransition === "function" && !reduceMotion;
}

/** Whether the reader asked for less motion. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The route for the current hash, updated on every hash change. */
export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => {
      const update = (): void => flushSync(() => setHash(window.location.hash));
      if (shouldAnimateRoutes(document, prefersReducedMotion())) document.startViewTransition(update);
      else update();
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and an
    // effect must return nothing or a cleanup function.
    window.scrollTo(0, 0);
  }, [hash]);
  return parseRoute(hash);
}
