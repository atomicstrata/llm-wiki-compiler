/**
 * Renders the loading and error states shared by every data-backed view, and
 * hands the loaded data to its child once it is ready.
 */
import type { ReactNode } from "react";
import type { AsyncState } from "./use-async";

interface AsyncViewProps<T> {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
}

/** Show a status line until `state` is ready, then render `children`. */
export function AsyncView<T>({ state, children }: AsyncViewProps<T>): ReactNode {
  if (state.status === "loading") return <p>Loading…</p>;
  if (state.status === "error") return <p role="alert">{state.message}</p>;
  return children(state.data);
}
