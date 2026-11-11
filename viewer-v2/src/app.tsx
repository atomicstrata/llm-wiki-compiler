/**
 * The v2 viewer shell: a header with search, the page list, and the view for
 * the current hash route.
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { fetchPages, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { HomeView } from "./home-view";
import { PageView } from "./page-view";
import { parseRoute, searchHref, type Route } from "./route";
import { SearchView } from "./search-view";
import { Sidebar } from "./sidebar";
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

/** The search box in the header. */
function SearchForm({ initialQuery }: { initialQuery: string }): ReactNode {
  const [query, setQuery] = useState(initialQuery);
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (query.trim().length > 0) window.location.hash = searchHref(query.trim());
  };
  return (
    <form className="search-form" role="search" onSubmit={onSubmit}>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the wiki"
        aria-label="Search the wiki"
      />
    </form>
  );
}

/** The view for one route. */
function RouteView({ route, wiki }: { route: Route; wiki: PagesEnvelope }): ReactNode {
  if (route.view === "page") return <PageView directory={route.directory} slug={route.slug} />;
  if (route.view === "source") return <SourceView id={route.id} lineStart={route.lineStart} lineEnd={route.lineEnd} />;
  if (route.view === "search") return <SearchView query={route.query} />;
  return <HomeView hasIndex={wiki.index.available} />;
}

/** Header, page list, and current view for a loaded wiki. */
function Shell({ wiki, route }: { wiki: PagesEnvelope; route: Route }): ReactNode {
  const [isListOpen, setListOpen] = useState(false);
  const activePageId = route.view === "page" ? `${route.directory}/${route.slug}` : null;
  return (
    <div className="shell" data-list-open={isListOpen}>
      <header className="topbar">
        <button type="button" className="list-toggle" aria-expanded={isListOpen} onClick={() => setListOpen(!isListOpen)}>
          Pages
        </button>
        <a className="project" href="#/">{wiki.project.title}</a>
        <SearchForm key={route.view === "search" ? route.query : ""} initialQuery={route.view === "search" ? route.query : ""} />
      </header>
      <Sidebar pages={wiki.pages} activePageId={activePageId} />
      <main onClick={() => setListOpen(false)}>
        <RouteView route={route} wiki={wiki} />
      </main>
    </div>
  );
}

/** Load the page list once, then render the shell for the current route. */
export function App(): ReactNode {
  const route = useRoute();
  const wiki = useAsync(fetchPages, "pages");
  return <AsyncView state={wiki}>{(loaded) => <Shell wiki={loaded} route={route} />}</AsyncView>;
}
