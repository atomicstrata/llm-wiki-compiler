/**
 * Media queries for the client. `useMediaQuery` keeps one as React state
 * through `useSyncExternalStore`, so a resize across the breakpoint
 * re-renders at once; where `matchMedia` does not exist (server rendering,
 * tests) the query reads as matching, which renders the wide layout.
 * `prefersReducedMotion` is the one place animations ask whether to run.
 */
import { useCallback, useSyncExternalStore } from "react";

/** Whether `query` matches now, kept current. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof matchMedia !== "function") return () => undefined;
    const list = matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => (typeof matchMedia === "function" ? matchMedia(query).matches : true), () => true);
}

/** Whether the reader asked for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
