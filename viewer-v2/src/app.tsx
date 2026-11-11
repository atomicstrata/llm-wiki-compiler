/**
 * The v2 viewer shell: header, navigation sidebar, and the view for the
 * current hash route. `/api/pages` and `/api/health` load once in parallel; a
 * failed health fetch only degrades the surfaces that need it.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { fetchHealth, fetchPages, type HealthPayload, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { Dashboard } from "./dashboard";
import { GraphView } from "./graph-view";
import { Header } from "./header";
import { HealthView } from "./health-view";
import { IndexView } from "./index-view";
import { ConceptsList, QueriesList, SourcesList, TypeList } from "./lists";
import { PageView } from "./page-view";
import { PendingView } from "./pending-view";
import { RecentView } from "./recent-view";
import { ReviewsView } from "./reviews-view";
import { parseRoute, type Route } from "./route";
import { SearchView } from "./search-view";
import { Sidebar } from "./nav";
import { SourceChangesView } from "./source-changes-view";
import { SourceView } from "./source-view";
import { useAsync } from "./use-async";

/** Subscribe to hash changes for `useSyncExternalStore`. */
function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The current route, updated whenever the hash changes. */
function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and an
    // effect must return nothing or a cleanup function.
    window.scrollTo(0, 0);
  }, [hash]);
  return parseRoute(hash);
}

/** The bootstrap payloads; health is null when its fetch fails. */
interface Bootstrap {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
}

async function loadBootstrap(): Promise<Bootstrap> {
  const [wiki, health] = await Promise.all([fetchPages(), fetchHealth().catch(() => null)]);
  return { wiki, health };
}

const STATE_WARNINGS: Partial<Record<PagesEnvelope["stateStatus"], string>> = {
  corrupt: "Warning: state.json is corrupt. Freshness data is unavailable. Re-run `llmwiki compile` to restore.",
  "too-new": "Warning: this wiki's state was written by a newer version of llmwiki. Update llmwiki to view it safely.",
};

const LISTS = { concepts: ConceptsList, queries: QueriesList, sources: SourcesList } as const;

/** The view for one route. */
// One flat case per route kind is the whole function; a table keyed by view
// would need a cast per entry to narrow the route, which hides more than the
// switch does (cognitive complexity: 1).
// fallow-ignore-next-line complexity
function RouteView({ route, wiki, health }: { route: Route; wiki: PagesEnvelope; health: HealthPayload | null }): ReactNode {
  switch (route.view) {
    case "page": return <PageView directory={route.directory} slug={route.slug} wiki={wiki} />;
    case "source": return <SourceView id={route.id} lineStart={route.lineStart} lineEnd={route.lineEnd} />;
    case "search": return <SearchView query={route.query} />;
    case "index": return <IndexView hasIndex={wiki.index.available} />;
    case "recent": return <RecentView wiki={wiki} />;
    case "graph": return <GraphView wiki={wiki} />;
    case "list": { const List = LISTS[route.kind]; return <List wiki={wiki} />; }
    case "typeList": return <TypeList wiki={wiki} type={route.type} />;
    case "home": return <Dashboard wiki={wiki} health={health} />;
    case "health": return <HealthView wiki={wiki} health={health} />;
    case "reviews": return <ReviewsView />;
    case "sourceChanges": return <SourceChangesView />;
    default: return <PendingView route={route} />;
  }
}

/** Header, navigation, and current view for a loaded wiki. */
function Shell({ wiki, health, route }: Bootstrap & { route: Route }): ReactNode {
  const [navOpen, setNavOpen] = useState(false);
  const warning = STATE_WARNINGS[wiki.stateStatus];
  return (
    <div className="shell" data-nav-open={navOpen}>
      {warning && <p className="state-banner" role="alert">{warning}</p>}
      <Header wiki={wiki} health={health} initialQuery={route.view === "search" ? route.query : ""}
        navOpen={navOpen} onToggleNav={() => setNavOpen(!navOpen)} />
      <Sidebar wiki={wiki} health={health} route={route} />
      <main onClick={() => setNavOpen(false)}>
        <RouteView route={route} wiki={wiki} health={health} />
      </main>
    </div>
  );
}

/** Load the bootstrap payloads once, then render the shell for the current route. */
export function App(): ReactNode {
  const route = useRoute();
  const bootstrap = useAsync(loadBootstrap, "bootstrap");
  return <AsyncView state={bootstrap}>{(loaded) => <Shell wiki={loaded.wiki} health={loaded.health} route={route} />}</AsyncView>;
}
