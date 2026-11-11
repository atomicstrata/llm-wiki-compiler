/**
 * The dashboard: stat cards, a hero with calls to action, the recently
 * compiled panel, the compact live graph, a compile receipt, and the next
 * actions the CLI offers.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { HealthPayload, PagesEnvelope, RecentPage } from "./api";
import { Badge, Button, ButtonLink, Card, DefinitionRows, Row, RowList, Stat, TextLink, type Tone } from "./components";
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

const CARD_TONE: Record<"warn" | "calm", Tone> = { warn: "amber", calm: "green" };

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
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-white px-5 py-4 shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10">
      <div>
        <p className="font-semibold text-zinc-950 dark:text-white">Your knowledge base is ready.</p>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{plural(pages, "page")}, {plural(citations, "citation")} traced to source spans.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {wiki.index.available && <ButtonLink href="#/index" primary>Browse compiled index →</ButtonLink>}{" "}
        <ButtonLink href="#/graph">Explore graph</ButtonLink>
      </div>
    </div>
  );
}

/** One recently compiled row, joined with the matching page row for freshness and citations. */
function RecentRow({ recent, wiki, now }: { recent: RecentPage; wiki: PagesEnvelope; now: Date }): ReactNode {
  const page = wiki.pages.find((row) => row.id === recent.id);
  const status = page?.freshness.freshnessStatus ?? "unverified";
  return (
    <Row href={pageHref(recent.pageDirectory, recent.slug)} title={recent.title || recent.slug}
      trailing={<>{isWarnFreshness(status) && <Badge tone="amber">{status}</Badge>}<Badge>{page?.citationCount ?? 0}</Badge></>}
      meta={relativeAge(recent.updatedAt, now)} />
  );
}

function RecentPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const now = useMemo(() => new Date(), [wiki]);
  const profile = profileVocabulary(wiki) !== null;
  return (
    <Card flush title={profile ? "Recently updated" : "Recently compiled"} action={<TextLink href="#/recent">View all</TextLink>}
      footer={<><span>cited pages, most recent first</span>{" "}<TextLink href="#/recent">All {plural(wiki.pages.length, "page")} →</TextLink></>}>
      {wiki.recentPages.length === 0 ? (
        <p className="p-4 text-sm text-zinc-500">{profile ? "Nothing authored yet." : "Nothing compiled yet. Compiled pages appear here newest first."}</p>
      ) : (
        <RowList>{wiki.recentPages.map((recent) => <RecentRow key={recent.id} recent={recent} wiki={wiki} now={now} />)}</RowList>
      )}
    </Card>
  );
}

/** The compact live graph; Fit stays disabled until the layout has settled. */
function GraphPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [controls, setControls] = useState<GraphControls | null>(null);
  const { nodeCount, edgeCount, danglingCount } = wiki.graph;
  return (
    <Card title="Knowledge graph"
      action={
        <span className="flex items-center gap-2">
          <Button disabled={controls === null} onClick={() => controls?.fit()}>Fit</Button>
          <a href="#/graph" title="Open the full graph explorer" aria-label="Open the full graph explorer" className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">⤢</a>
        </span>
      }
      footer={<><span>hover a node to inspect</span>{" "}<span>{plural(danglingCount, "dangling target")}</span></>}>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{plural(nodeCount, "node")} · {plural(edgeCount, "edge")}</p>
      <GraphLegend compact />
      <GraphCanvas wiki={wiki} compact onSettled={setControls} />
    </Card>
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
    <Card title="Compile receipt">
      <DefinitionRows rows={rows} />
      <div className="mt-4 border-t border-zinc-950/5 pt-4 dark:border-white/10">
        <div className="flex justify-between text-sm"><span className="text-zinc-500 dark:text-zinc-400">Citations resolved</span>{" "}<span className="font-medium tabular-nums">{percent}%</span></div>
        <meter min={0} max={100} value={percent} className="mt-2 h-2 w-full" />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{resolved} of {totals.total} citations resolve to a source file</p>
      </div>
    </Card>
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
    <div className="mx-auto max-w-6xl space-y-6">
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statCards(wiki, dangling, totals.unresolved).map((card) => {
          const tone = card.tone ? CARD_TONE[card.tone] : "neutral";
          return (
            <div key={card.key} data-stat={card.key}>
              <Stat label={card.label} value={card.value} detail={card.sub} tone={tone} badge={card.tone && <Badge tone={tone}>{card.badge}</Badge>} />
            </div>
          );
        })}
      </dl>
      <Hero wiki={wiki} />
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentPanel wiki={wiki} />
        <GraphPanel wiki={wiki} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Receipt wiki={wiki} health={health} totals={totals} />
        <Card title="Next actions"
          footer={<span>The viewer rereads the wiki from disk every few seconds, so a compile shows up without a restart.</span>}>
          <ul role="list" className="space-y-3">
            {nextActions(wiki, health, dangling).map((row) => (
              <li key={row.title} className="flex gap-3 text-sm">
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-zinc-950/5 text-zinc-500 dark:bg-white/5 dark:text-zinc-400" aria-hidden="true">{row.glyph}</span>{" "}
                <span className="min-w-0"><strong className="block font-medium text-zinc-900 dark:text-zinc-100">{row.title}</strong>{" "}<span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.hint}</span></span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
