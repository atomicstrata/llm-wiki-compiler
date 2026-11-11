/**
 * The current hash route, with a short cross-fade between screens.
 *
 * A hash change is applied inside `document.startViewTransition`, flushed
 * synchronously so the browser snapshots the new screen, which is how the
 * View Transitions API animates a single-page app. Browsers without the API
 * get the plain update; for readers who ask for reduced motion the stylesheet
 * turns the animation off.
 *
 * Every route change scrolls to the top, as a new page would. That runs as a
 * layout effect so it lands before the new screen's own passive effects: a
 * source opened at cited lines scrolls those lines into view afterwards, and
 * wins.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { parseRoute, type Route } from "./route";

/** Whether the browser can animate a route change. */
export function supportsViewTransitions(doc: Partial<Pick<Document, "startViewTransition">> | undefined): boolean {
  return typeof doc?.startViewTransition === "function";
}

/** The route for the current hash, updated on every hash change. */
export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => {
      const update = (): void => flushSync(() => setHash(window.location.hash));
      if (supportsViewTransitions(document)) document.startViewTransition(update);
      else update();
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  useLayoutEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and an
    // effect must return nothing or a cleanup function.
    window.scrollTo(0, 0);
  }, [hash]);
  return parseRoute(hash);
}
