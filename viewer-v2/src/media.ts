/**
 * A media query as React state, through `useSyncExternalStore` so a resize
 * across the breakpoint re-renders at once. Where `matchMedia` does not exist
 * (server rendering, tests) the query reads as matching, which renders the
 * wide layout.
 */
import { useSyncExternalStore } from "react";

/** Whether `query` matches now, kept current. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia !== "function") return () => undefined;
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof matchMedia === "function" ? matchMedia(query).matches : true),
    () => true,
  );
}
