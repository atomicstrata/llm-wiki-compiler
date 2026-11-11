/**
 * The fallback for a route the shell has no screen for. Every screen of the
 * original client now exists here, so this renders only if a route kind is
 * added without a view.
 */
import type { ReactNode } from "react";
import type { Route } from "./route";

/** Name the route and point at the original client. */
export function PendingView({ route }: { route: Route }): ReactNode {
  return (
    <section>
      <h1>Not available</h1>
      <p>This client has no screen for <code>{route.view}</code>. Open it with <code>llmwiki view</code> at the same address.</p>
    </section>
  );
}
