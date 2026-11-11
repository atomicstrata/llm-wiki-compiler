/**
 * The fallback for a route the shell has no screen for. Every screen of the
 * original client now exists here, so this renders only if a route kind is
 * added without a view.
 */
import type { ReactNode } from "react";
import { Code, EmptyState, Screen } from "./components";
import type { Route } from "./route";

/** Name the route and point at the original client. */
export function PendingView({ route }: { route: Route }): ReactNode {
  return (
    <Screen title="Not available" description={<>This client has no screen for <Code>{route.view}</Code>.</>}>
      <EmptyState title="Open it in the original viewer" body="Run llmwiki view at the same address to reach this screen." command="$ llmwiki view" />
    </Screen>
  );
}
