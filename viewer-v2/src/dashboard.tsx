/**
 * The dashboard: stat cards, a hero with calls to action, the recently
 * compiled panel, the compact live graph, a compile receipt, and the next
 * actions the CLI offers.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { HealthPayload, PagesEnvelope, RecentPage } from "./api";
import { GraphCanvas, GraphLegend } from "./graph-canvas";
import type { GraphControls } from "./graph-layout";
import { relativeAge } from "./recency";
import { pageHref } from "./route";
import { citationTotals, isWarnFreshness, lintTotal, plural, profileVocabulary } from "./wiki-model";

interface StatCard {
  key: string;
  label: string;
  badge: string;
  value: number;
  sub: string;
  tone?: "warn" | "calm";
}

/** The four cards: the inventory card changes with the profile, the rest are fixed. */
function statCards(wiki: PagesEnvelope, dangling: number, unresolved: number): StatCard[] {
  const vocabulary = profileVocabulary(wiki);
  const concepts = citationTotals(wiki.pages.filter((page) => page.pageDirectory === "concepts")).total;
  const inventory: StatCard = vocabulary
    ? { key: "pages", label: "Entity pages", badge: "PAGES", value: vocabulary.pageCount, sub: `${plural(vocabulary.citationCount, "citation")} · ${plural(vocabulary.typeCount, "type")}` }
    : { key: "concepts", label: "Concepts", badge: "PAGES", value: wiki.counts.concepts, sub: `${plural(concepts, "citation")} · ${plural(wiki.counts.concepts, "page")}` };
  const attention = dangling + unresolved;
  const pending = wiki.counts.pendingReviews;
  return [
    inventory,
    { key: "sources", label: "Sources", badge: "INPUT", value: wiki.counts.sourceFiles, sub: `${wiki.counts.compiledSources} compiled · ${wiki.counts.sourceFiles} on disk` },
    { key: "attention", label: "Needs attention", badge: "LINT", value: attention, sub: `${dangling} broken page links · ${plural(unresolved, "unresolved citation")}`, tone: attention > 0 ? "warn" : undefined },
    { key: "reviews", label: "Awaiting review", badge: pending === 0 ? "CLEAR" : "QUEUE", value: pending, sub: pending === 0 ? "queue is empty" : plural(pending, "candidate"), tone: pending > 0 ? "warn" : "calm" },
  ];
}

function Hero({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const vocabulary = profileVocabulary(wiki);
  const pages = vocabulary ? vocabulary.pageCount : wiki.counts.concepts;
  const citations = vocabulary ? vocabulary.citationCount : citationTotals(wiki.pages).total;
  return (
    <div>
      <div>
        <strong>Your knowledge base is ready.</strong>
        <p>{plural(pages, "page")}, {plural(citations, "citation")} traced to source spans.</p>
      </div>
      <div>
        {wiki.index.available && <a href="#/index">Browse compiled index →</a>}{" "}
        <a href="#/graph">Explore graph</a>
      </div>
    </div>
  );
}

/** One recently compiled row, joined with the matching page row for freshness and citations. */
function RecentRow({ recent, wiki, now }: { recent: RecentPage; wiki: PagesEnvelope; now: Date }): ReactNode {
  const page = wiki.pages.find((row) => row.id === recent.id);
  const status = page?.freshness.freshnessStatus ?? "unverified";
  return (
    <li>
      {isWarnFreshness(status) && <span>{status}</span>}{" "}
      <a href={pageHref(recent.pageDirectory, recent.slug)}>{recent.title || recent.slug}</a>{" "}
      <span>{page?.citationCount ?? 0}</span>{" "}
      <span>{relativeAge(recent.updatedAt, now)}</span>
    </li>
  );
}

function RecentPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const now = useMemo(() => new Date(), [wiki]);
  const profile = profileVocabulary(wiki) !== null;
  return (
    <section>
      <div><span>{profile ? "Recently updated" : "Recently compiled"}</span>{" "}<a href="#/recent">View all</a></div>
      {wiki.recentPages.length === 0 ? (
        <p>{profile ? "Nothing authored yet." : "Nothing compiled yet. Compiled pages appear here newest first."}</p>
      ) : (
        <ul>{wiki.recentPages.map((recent) => <RecentRow key={recent.id} recent={recent} wiki={wiki} now={now} />)}</ul>
      )}
      <div><span>cited pages, most recent first</span>{" "}<a href="#/recent">All {plural(wiki.pages.length, "page")} →</a></div>
    </section>
  );
}

/** The compact live graph; Fit stays disabled until the layout has settled. */
function GraphPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [controls, setControls] = useState<GraphControls | null>(null);
  const { nodeCount, edgeCount, danglingCount } = wiki.graph;
  return (
    <section>
      <div>
        <span>Knowledge graph</span>{" "}
        <span>
          <button type="button" disabled={controls === null} onClick={() => controls?.fit()}>Fit</button>
          <a href="#/graph" title="Open the full graph explorer" aria-label="Open the full graph explorer">⤢</a>
        </span>
      </div>
      <p>{plural(nodeCount, "node")} · {plural(edgeCount, "edge")}</p>
      <GraphLegend compact />
      <div><GraphCanvas wiki={wiki} compact onSettled={setControls} /></div>
      <div><span>hover a node to inspect</span>{" "}<span>{plural(danglingCount, "dangling target")}</span></div>
    </section>
  );
}

/** The compile receipt and the citations-resolved meter. */
function Receipt({ wiki, health, totals }: { wiki: PagesEnvelope; health: HealthPayload | null; totals: { total: number; unresolved: number } }): ReactNode {
  const lint = lintTotal(health);
  const resolved = totals.total - totals.unresolved;
  const percent = totals.total === 0 ? 100 : Math.round((resolved / totals.total) * 100);
  const rows: [string, string][] = [
    ["Root", wiki.project.rootName || "—"],
    ["Profile", wiki.profileId],
    ["State", wiki.stateStatus],
    ["Index", wiki.index.available ? "available" : "not compiled"],
    ["Lint", lint === null ? "never run" : plural(lint, "finding")],
  ];
  return (
    <section>
      <div><span>Compile receipt</span></div>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div>
        <div><span>Citations resolved</span>{" "}<span>{percent}%</span></div>
        <meter min={0} max={100} value={percent} />
        <p>{resolved} of {totals.total} citations resolve to a source file</p>
      </div>
    </section>
  );
}

/** The CLI actions that currently apply; the export hint always does. */
function nextActions(wiki: PagesEnvelope, health: HealthPayload | null, dangling: number): { glyph: string; title: string; hint: string }[] {
  const rows = [];
  if (dangling > 0) rows.push({ glyph: "⌗", title: `Resolve ${plural(dangling, "dangling link")}`, hint: "create the pages or fix the targets" });
  if (wiki.counts.stale > 0) rows.push({ glyph: "↻", title: `Recompile ${plural(wiki.counts.stale, "stale page")}`, hint: "llmwiki compile" });
  if (lintTotal(health) === null) rows.push({ glyph: "✓", title: "Run lint", hint: "llmwiki lint" });
  rows.push({ glyph: "⇩", title: "Export for agents", hint: "llmwiki export" });
  return rows;
}

/** The dashboard screen. */
export function Dashboard({ wiki, health }: { wiki: PagesEnvelope; health: HealthPayload | null }): ReactNode {
  const totals = citationTotals(wiki.pages);
  const dangling = wiki.graph.danglingCount;
  return (
    <div>
      <div>
        {statCards(wiki, dangling, totals.unresolved).map((card) => (
          <div key={card.key} data-stat={card.key}>
            <div><span>{card.label}</span>{" "}<span>{card.badge}</span></div>
            <strong>{card.value}</strong>{" "}
            <span>{card.sub}</span>
          </div>
        ))}
      </div>
      <Hero wiki={wiki} />
      <div>
        <RecentPanel wiki={wiki} />
        <GraphPanel wiki={wiki} />
      </div>
      <div>
        <Receipt wiki={wiki} health={health} totals={totals} />
        <section>
          <div><span>Next actions</span></div>
          <ul>
            {nextActions(wiki, health, dangling).map((row) => (
              <li key={row.title}><span>{row.glyph}</span>{" "}<span><strong>{row.title}</strong>{" "}<span>{row.hint}</span></span></li>
            ))}
          </ul>
          <p>The viewer rereads the wiki from disk every few seconds, so a compile shows up without a restart.</p>
        </section>
      </div>
    </div>
  );
}
