/**
 * A screen this client does not have yet. The route is reserved and the
 * sidebar entry exists so links keep working while the screen is built; until
 * then the original client at `llmwiki view` shows it.
 */
import type { ReactNode } from "react";
import type { Route } from "./route";

const TITLES: Partial<Record<Route["view"], string>> = {
  workflows: "Workflows",
  pipeline: "Lifecycle status",
};

/** Name the screen and point at the client that has it. */
export function PendingView({ route }: { route: Route }): ReactNode {
  return (
    <section>
      <h1>{TITLES[route.view] ?? "Not available"}</h1>
      <p className="status">This screen is not in the v2 client yet. Open it with <code>llmwiki view</code> at the same address.</p>
    </section>
  );
}
