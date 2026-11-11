/**
 * The sidebar: project identity and navigation with counts.
 *
 * Browse holds the default project's Concepts and Queries, or a profile's
 * declared types in their place. Explore and Maintain are fixed. A zero count
 * reads as an em dash under Browse and Explore (nothing to browse) and as a
 * literal 0 under Maintain (a reassuring fact). Profile-only rows appear only
 * on profile projects. When a profile type shares a fixed row's name, the
 * fixed row takes its longer collision label so the two stay distinct.
 */
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import type { Route } from "./route";
import { typeListHref } from "./route";
import { entityTypes, isProfileProject, lintTotal, typeLabel } from "./wiki-model";

/** How a zero count is written in a section. */
type ZeroDisplay = "dash" | "digit";

interface NavItem {
  route: string;
  href: string;
  label: string;
  count?: number;
  collisionLabel?: string;
  profileOnly?: boolean;
}

interface NavSection {
  label: string;
  zero: ZeroDisplay;
  items: NavItem[];
}

/** The many-types threshold past which the Browse header also shows the count. */
const MANY_TYPES = 11;

/** Browse rows: the profile's types sorted by page count, else Concepts and Queries. */
function browseItems(wiki: PagesEnvelope): NavItem[] {
  const types = entityTypes(wiki);
  if (types.length === 0) {
    return [
      { route: "concepts", href: "#/concepts", label: "Concepts", count: wiki.counts.concepts },
      { route: "queries", href: "#/queries", label: "Queries", count: wiki.counts.queries },
    ];
  }
  return [...types]
    .sort((a, b) => b.pageCount - a.pageCount)
    .map((row) => ({ route: row.type, href: typeListHref(row.type), label: typeLabel(row.type), count: row.pageCount }));
}

/** Every section with its rows, counts filled in from the payloads. */
function sections(wiki: PagesEnvelope, health: HealthPayload | null): NavSection[] {
  const lint = lintTotal(health);
  const typeCount = entityTypes(wiki).length;
  return [
    { label: typeCount > 0 ? "CATEGORIES" : "BROWSE", zero: "dash", items: browseItems(wiki) },
    {
      label: "EXPLORE",
      zero: "dash",
      items: [
        { route: "recent", href: "#/recent", label: "Recent" },
        { route: "sources", href: "#/sources", label: "Sources", collisionLabel: "Source files", count: wiki.counts.sourceFiles },
        { route: "graph", href: "#/graph", label: "Graph explorer" },
      ],
    },
    {
      label: "MAINTAIN",
      zero: "digit",
      items: [
        { route: "health", href: "#/health", label: "Health & lint", count: lint ?? undefined },
        { route: "reviews", href: "#/reviews", label: "Reviews", collisionLabel: "Review queue", count: wiki.counts.pendingReviews },
        { route: "workflows", href: "#/workflows", label: "Workflows", profileOnly: true },
        { route: "pipeline", href: "#/pipeline", label: "Lifecycle status", count: typeCount, profileOnly: true },
      ],
    },
  ];
}

/** The nav route name the current route lights up, or null. */
export function activeNavRoute(route: Route): string | null {
  if (route.view === "home" || route.view === "index") return "home";
  if (route.view === "list") return route.kind;
  if (route.view === "typeList" || route.view === "page") return route.view === "typeList" ? route.type : route.directory;
  if (route.view === "sourceChanges") return "source-changes";
  if (route.view === "search" || route.view === "source") return null;
  return route.view;
}

/** The count text, or null when the item has no count. */
function countText(item: NavItem, zero: ZeroDisplay): string | null {
  if (item.count === undefined) return null;
  if (item.count > 0) return String(item.count);
  return zero === "dash" ? "—" : "0";
}

function NavRow({ item, zero, active, label }: { item: NavItem; zero: ZeroDisplay; active: boolean; label: string }): ReactNode {
  const count = countText(item, zero);
  return (
    <li>
      <a href={item.href} data-route={item.route} aria-current={active ? "page" : undefined} title={label}>
        <span className="nav-label">{label}</span>
        {count !== null && <span className={`nav-count${count === "—" || count === "0" ? " nav-count-zero" : ""}`}>{count}</span>}
      </a>
    </li>
  );
}

interface SidebarProps {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
  route: Route;
}

/** Project identity and the three navigation sections. */
export function Sidebar({ wiki, health, route }: SidebarProps): ReactNode {
  const active = activeNavRoute(route);
  const profile = isProfileProject(wiki);
  const typeLabels = new Set(browseItems(wiki).map((item) => item.label));
  return (
    <nav className="sidebar" aria-label="Wiki navigation">
      <div className="project-block">
        <span className="project-label">PROJECT</span>
        <strong className="project-name">{wiki.project.title || "llmwiki"}</strong>
        <span className="project-status">LOCAL · READ ONLY</span>
      </div>
      <ul className="nav-list">
        <NavRow item={{ route: "home", href: "#/", label: "Dashboard" }} zero="dash" active={active === "home"} label="Dashboard" />
      </ul>
      {sections(wiki, health).map((section) => (
        <section key={section.label} className="nav-section">
          <h2 className="nav-section-label">
            {section.label}
            {section.label === "CATEGORIES" && (
              <span className="nav-section-meta">{entityTypes(wiki).length > MANY_TYPES ? `${wiki.profileId} · ${entityTypes(wiki).length}` : wiki.profileId}</span>
            )}
          </h2>
          <ul className="nav-list">
            {section.items
              .filter((item) => !item.profileOnly || profile)
              .map((item) => (
                <NavRow
                  key={item.route}
                  item={item}
                  zero={section.zero}
                  active={active === item.route}
                  label={item.collisionLabel !== undefined && typeLabels.has(item.label) ? item.collisionLabel : item.label}
                />
              ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
