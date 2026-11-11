/**
 * The v2 viewer shell: header, navigation sidebar, and the view for the
 * current hash route. `/api/pages` and `/api/health` load in parallel and
 * stay live while the tab is visible; a failed health fetch only degrades the
 * surfaces that need it. Hover previews, the command palette and the
 * keyboard shortcuts mount once here, so they work from every view.
 */
import { useEffect, type ReactNode } from "react";
import { stampVisit } from "./activity-model";
import type { HealthPayload, PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { CommandPalette } from "./command-palette";
import { Dashboard } from "./dashboard";
import { GraphView } from "./graph-view";
import { Header } from "./header";
import { HealthView } from "./health-view";
import { HoverPreviews } from "./hover-preview";
import { IndexView } from "./index-view";
import { JourneyView } from "./journey-view";
import { ConceptsList, QueriesList, SourcesList, TagList, TypeList } from "./lists";
import { useLiveBootstrap, type Bootstrap } from "./live-bootstrap";
import { Sidebar } from "./nav";
import { PageView } from "./page-view";
import { PipelineView } from "./pipeline-view";
import { RecentView } from "./recent-view";
import { ReviewsView } from "./reviews-view";
import type { Route } from "./route";
import { SearchView } from "./search-view";
import { KeyboardShortcuts } from "./shortcuts";
import { SourceChangesView } from "./source-changes-view";
import { SourceView } from "./source-view";
import { TimelineView } from "./timeline-view";
import { safeLocalStorage } from "./storage";
import { useRoute } from "./use-route";
import { WorkflowsView } from "./workflows-view";

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
    case "timeline": return <TimelineView wiki={wiki} />;
    case "graph": return <GraphView wiki={wiki} />;
    case "list": { const List = LISTS[route.kind]; return <List wiki={wiki} />; }
    // Keyed so the title and freshness filters start fresh on each list.
    case "typeList": return <TypeList key={route.type} wiki={wiki} type={route.type} />;
    case "tag": return <TagList key={route.tag} wiki={wiki} tag={route.tag} />;
    case "pipeline": return <PipelineView wiki={wiki} />;
    case "workflows": return <WorkflowsView />;
    case "journey": return <JourneyView workflowId={route.workflowId} runId={route.runId} />;
    case "home": return <Dashboard wiki={wiki} health={health} />;
    case "health": return <HealthView wiki={wiki} health={health} />;
    case "reviews": return <ReviewsView />;
    case "sourceChanges": return <SourceChangesView />;
    default: return route satisfies never;
  }
}

/** Header, navigation, and current view for a loaded wiki. */
function Shell({ wiki, health, route }: Bootstrap & { route: Route }): ReactNode {
  const warning = STATE_WARNINGS[wiki.stateStatus];
  const routeKey = JSON.stringify(route);
  // Every screen change is activity, so a reader who keeps reading stays in one visit.
  useEffect(() => { stampVisit(safeLocalStorage(), new Date()); }, [routeKey]);
  return (
    <>
      {warning && <p role="alert" className="bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{warning}</p>}
      <Header wiki={wiki} health={health} />
      {/* Narrow screens open the navigation from a disclosure; it resets on every route so it closes after a choice. */}
      <details key={routeKey} className="border-b border-zinc-950/5 bg-white md:hidden dark:border-white/10 dark:bg-zinc-900">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Menu</summary>
        <Sidebar wiki={wiki} health={health} route={route} />
      </details>
      <div className="md:flex">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-950/5 md:sticky md:top-14 md:block md:h-[calc(100dvh-3.5rem)] md:overflow-y-auto dark:border-white/10">
          <Sidebar wiki={wiki} health={health} route={route} />
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12">
          <RouteView route={route} wiki={wiki} health={health} />
        </main>
      </div>
      <HoverPreviews wiki={wiki} />
      <CommandPalette wiki={wiki} health={health} />
      <KeyboardShortcuts />
    </>
  );
}

/** Load the bootstrap payloads once, then render the shell for the current route. */
export function App(): ReactNode {
  const route = useRoute();
  const bootstrap = useLiveBootstrap();
  return <AsyncView state={bootstrap}>{(loaded) => <Shell wiki={loaded.wiki} health={loaded.health} route={route} />}</AsyncView>;
}
