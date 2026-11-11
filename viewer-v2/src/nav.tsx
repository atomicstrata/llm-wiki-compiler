/**
 * The sidebar: navigation with counts.
 *
 * Reading comes first: the dashboard, the compiled overview when the wiki
 * has one, and the timeline of compiles. Browse holds the default project's
 * Concepts and Queries, or a profile's declared types in their place.
 * Explore and Maintain are fixed. A zero count reads as an em dash under
 * Browse and Explore (nothing to browse) and as a literal 0 under Maintain (a
 * reassuring fact). Profile-only rows appear only on profile projects. When
 * a profile type shares a fixed row's name, the fixed row takes its longer
 * collision label so the two stay distinct. The same rows, flattened, are the
 * palette's "Go to" destinations.
 */
import { Activity, BookOpen, CalendarClock, FileText, Folder, Inbox, LayoutDashboard, Lightbulb, ListChecks, MessageCircleQuestion, Network, Workflow, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { typeListHref, type Route } from "./route";
import { entityTypes, humanLabel, isProfileProject, lintTotal } from "./wiki-model";

/** How a zero count is written in a section. */
type ZeroDisplay = "dash" | "digit";

interface NavItem {
  route: string;
  href: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  collisionLabel?: string;
  profileOnly?: boolean;
}

interface NavSection {
  label: string;
  /** A quiet note beside the label: the profile on a profile project's category list. */
  detail?: string;
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
      { route: "concepts", href: "#/concepts", label: "Concepts", icon: Lightbulb, count: wiki.counts.concepts },
      { route: "queries", href: "#/queries", label: "Queries", icon: MessageCircleQuestion, count: wiki.counts.queries },
    ];
  }
  return [...types]
    .sort((a, b) => b.pageCount - a.pageCount)
    .map((row) => ({ route: row.type, href: typeListHref(row.type), label: humanLabel(row.type), icon: Folder, count: row.pageCount }));
}

/** Every section with its rows, counts filled in from the payloads. */
function sections(wiki: PagesEnvelope, health: HealthPayload | null): NavSection[] {
  const lint = lintTotal(health);
  const typeCount = entityTypes(wiki).length;
  const browse: NavSection = typeCount > 0
    ? { label: "Categories", detail: typeCount > MANY_TYPES ? `${wiki.profileId} · ${typeCount}` : wiki.profileId, zero: "dash", items: browseItems(wiki) }
    : { label: "Browse", zero: "dash", items: browseItems(wiki) };
  return [
    browse,
    {
      label: "Explore",
      zero: "dash",
      items: [
        { route: "sources", href: "#/sources", label: "Sources", icon: FileText, collisionLabel: "Source files", count: wiki.counts.sourceFiles },
        { route: "graph", href: "#/graph", label: "Graph explorer", icon: Network },
      ],
    },
    {
      label: "Maintain",
      zero: "digit",
      items: [
        { route: "health", href: "#/health", label: "Health & lint", icon: Activity, count: lint ?? undefined },
        { route: "reviews", href: "#/reviews", label: "Reviews", icon: Inbox, collisionLabel: "Review queue", count: wiki.counts.pendingReviews },
        { route: "workflows", href: "#/workflows", label: "Workflows", icon: Workflow, profileOnly: true },
        { route: "pipeline", href: "#/pipeline", label: "Lifecycle status", icon: ListChecks, count: typeCount, profileOnly: true },
      ],
    },
  ];
}

/** The rows above the sections: where a reader starts, then the overview and the timeline. */
function readingItems(wiki: PagesEnvelope): NavItem[] {
  return [
    { route: "home", href: "#/", label: "Dashboard", icon: LayoutDashboard },
    ...(wiki.index.available ? [{ route: "index", href: "#/index", label: "Overview", icon: BookOpen }] : []),
    { route: "recent", href: "#/recent", label: "Timeline", icon: CalendarClock },
  ];
}

/** The rows a project shows: profile-only rows on profile projects, with collision labels resolved. */
function visibleSections(wiki: PagesEnvelope, health: HealthPayload | null): NavSection[] {
  const profile = isProfileProject(wiki);
  const all = sections(wiki, health);
  const typeLabels = new Set(all[0].items.map((item) => item.label));
  return all.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => !item.profileOnly || profile)
      .map((item) => (item.collisionLabel !== undefined && typeLabels.has(item.label) ? { ...item, label: item.collisionLabel } : item)),
  }));
}

/** One place the palette can go. */
export interface Destination {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Every sidebar row as a palette destination, the reading rows first. */
export function navDestinations(wiki: PagesEnvelope, health: HealthPayload | null): Destination[] {
  return [...readingItems(wiki), ...visibleSections(wiki, health).flatMap((section) => section.items)].map(({ href, label, icon }) => ({ href, label, icon }));
}

/** The nav route name the current route lights up, or null. */
export function activeNavRoute(route: Route): string | null {
  if (route.view === "list") return route.kind;
  if (route.view === "typeList") return route.type;
  if (route.view === "page") return route.directory;
  // The source review cockpit is reached from Reviews and has no row of its own.
  if (route.view === "sourceChanges") return "reviews";
  if (route.view === "journey") return "workflows";
  if (route.view === "search" || route.view === "source" || route.view === "tag") return null;
  return route.view;
}

/** The count text, or null when the item has no count. */
function countText(item: NavItem, zero: ZeroDisplay): string | null {
  if (item.count === undefined) return null;
  if (item.count > 0) return String(item.count);
  return zero === "dash" ? "—" : "0";
}

function NavRow({ item, zero, active }: { item: NavItem; zero: ZeroDisplay; active: boolean }): ReactNode {
  const count = countText(item, zero);
  return (
    <li>
      <a href={item.href} data-route={item.route} aria-current={active ? "page" : undefined} title={item.label}
        className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 aria-[current=page]:bg-zinc-950/5 aria-[current=page]:font-medium aria-[current=page]:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/5 dark:aria-[current=page]:text-white">
        <item.icon className="size-4 shrink-0 text-zinc-400 group-hover:text-zinc-600 group-aria-[current=page]:text-indigo-600 dark:text-zinc-500 dark:group-hover:text-zinc-300 dark:group-aria-[current=page]:text-indigo-400" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count !== null && <span className="text-xs text-zinc-400 tabular-nums dark:text-zinc-500">{count}</span>}
      </a>
    </li>
  );
}

interface SidebarProps {
  wiki: PagesEnvelope;
  health: HealthPayload | null;
  route: Route;
}

/** The reading rows and the three navigation sections. */
export function Sidebar({ wiki, health, route }: SidebarProps): ReactNode {
  const active = activeNavRoute(route);
  return (
    <nav aria-label="Wiki navigation" className="space-y-6 px-3 py-5">
      <ul role="list" className="space-y-0.5">
        {readingItems(wiki).map((item) => <NavRow key={item.route} item={item} zero="dash" active={active === item.route} />)}
      </ul>
      {visibleSections(wiki, health).map((section) => (
        <section key={section.label}>
          <h2 className="mb-1 flex justify-between px-2 text-xs font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
            <span className="uppercase">{section.label}</span>
            {section.detail && <span className="font-normal">{section.detail}</span>}
          </h2>
          <ul role="list" className="space-y-0.5">
            {section.items.map((item) => (
              <NavRow key={item.route} item={item} zero={section.zero} active={active === item.route} />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
