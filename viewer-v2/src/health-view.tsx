/**
 * The health screen: is anything wrong, what is it, and where. A head with
 * the lint caption, the contents strip of plain counts, then the Lint panel
 * beside a column of record problems (profile projects only), Freshness,
 * Traceability and the cache note. The whole-wiki verdict stays in the
 * header; the panels report their own scoped facts.
 *
 * Health arrives with the bootstrap, but lint is re-read from disk on every
 * request, so the screen refetches `/api/health` on each visit and shows the
 * bootstrap payload until the fresh one lands.
 */
import { useMemo, type ReactNode } from "react";
import { fetchHealth, type HealthPayload, type LintSummary, type PagesEnvelope } from "./api";
import { Badge, Card, Code, Disclosure, RowList, Screen, Table, Td, TextLink, TONE_TEXT, type Tone } from "./components";
import {
  contentsColumns, countFigure, freshnessSummary, lintFooter, lintRuleRows, lintRunCaption, problemsSummary, traceability,
  type FreshnessSummary, type LintFooter, type LintRow,
} from "./health-model";
import { useAsync } from "./use-async";
import { plural } from "./wiki-model";

const RULE_COLUMNS = ["Rule", "Most affected", "Count", "Page"];

/** How each freshness verdict reads as a badge. */
const FRESHNESS_TONE: Record<FreshnessSummary["badge"]["tone"], Tone> = { ok: "green", warn: "amber", unknown: "neutral" };

/** A count as a status badge: `1 PROBLEM`, `4 PROBLEMS`. */
function problemBadge(total: number): string {
  return plural(total, "problem").toUpperCase();
}

function ContentsStrip({ health, wiki }: { health: HealthPayload | null; wiki: PagesEnvelope }): ReactNode {
  return (
    <Card title="Contents" action={<span className="text-xs text-zinc-500 dark:text-zinc-400">counts only — nothing here is a problem</span>}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {contentsColumns(health, wiki).map((column) => (
          <div key={column.key} data-contents={column.key}>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{column.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">{countFigure(column.value)}</dd>
            <dd className="text-xs text-zinc-500 dark:text-zinc-400">{column.suffix}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Errors read red and warnings amber only while there are some; zero stays neutral. */
function LintSummaryBand({ lint }: { lint: LintSummary }): ReactNode {
  const figures: [string, number, Tone][] = [["error", lint.errors, "red"], ["warning", lint.warnings, "amber"]];
  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      {figures.map(([noun, count, tone]) => (
        <div key={noun} className="flex items-baseline gap-2">
          <span className={`text-3xl font-semibold tracking-tight tabular-nums ${TONE_TEXT[count > 0 ? tone : "neutral"]}`}>{count}</span>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">{noun}{count === 1 ? "" : "s"}</span>
        </div>
      ))}
    </div>
  );
}

/** A link only when the flagged file is a page this viewer renders; a link that 404s is worse than none. */
function RuleRow({ row }: { row: LintRow }): ReactNode {
  return (
    <tr>
      <Td><span className="font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">{row.rule}</span></Td>
      <Td>{row.affected}</Td>
      <Td><span className="tabular-nums">{row.count}</span></Td>
      <Td>{row.href === null ? "—" : <TextLink href={row.href}>view →</TextLink>}</Td>
    </tr>
  );
}

/** The figures and the rule table; the table only when there are rules. */
function LintBody({ lint, pageIndex }: { lint: LintSummary; pageIndex: Set<string> }): ReactNode {
  const rows = lintRuleRows(lint.rules ?? [], pageIndex);
  return (
    <>
      <LintSummaryBand lint={lint} />
      {rows.length > 0 && (
        <div className="border-t border-zinc-950/5 dark:border-white/10">
          <Table head={RULE_COLUMNS}>{rows.map((row) => <RuleRow key={row.rule} row={row} />)}</Table>
        </div>
      )}
    </>
  );
}

/** The sentence naming the dominant rule and where to fix it. */
function LintFooterLine({ footer }: { footer: LintFooter }): ReactNode {
  return (
    <>
      <span>{footer.insight}</span>
      {footer.action && <TextLink href={footer.action.href}>{footer.action.label}</TextLink>}
    </>
  );
}

/** The lint summary; a lint that never ran is a real, common state, not an error. */
function LintPanel({ lint, pageIndex }: { lint: LintSummary | null; pageIndex: Set<string> }): ReactNode {
  if (lint === null) {
    return <Card title="Lint"><p className="text-sm text-zinc-500 dark:text-zinc-400">No cached lint summary yet — run <Code>llmwiki lint</Code>.</p></Card>;
  }
  const total = lint.errors + lint.warnings;
  const footer = lintFooter(lint.rules ?? [], total, pageIndex);
  return (
    <Card flush title="Lint" action={<Badge tone={total > 0 ? "amber" : "green"}>{problemBadge(total)}</Badge>}
      footer={footer && <LintFooterLine footer={footer} />}>
      <LintBody lint={lint} pageIndex={pageIndex} />
    </Card>
  );
}

/** A profile project's record problems; nothing for a default project, which has none to be empty about. */
export function ProblemsPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { rows, total, notice } = problemsSummary(wiki);
  if (rows.length === 0) return null;
  return (
    <Card flush title="Record problems" action={<Badge tone="amber">{problemBadge(total)}</Badge>} footer={notice && <span>{notice}</span>}>
      <RowList>
        {rows.map((row, index) => (
          <li key={index} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <strong className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</strong>
              {row.where && <span className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">{row.where}</span>}
            </div>
            <p className="text-zinc-700 dark:text-zinc-300">{row.message}</p>
            <Disclosure quiet summary="Technical details"><p>Problem code: <Code>{row.code}</Code></p></Disclosure>
          </li>
        ))}
      </RowList>
    </Card>
  );
}

function FreshnessPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { badge, note } = freshnessSummary(wiki.pages.filter((page) => page.pageDirectory === "concepts"));
  return (
    <Card title="Freshness" action={<Badge tone={FRESHNESS_TONE[badge.tone]}>{badge.text}</Badge>}>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{note}</p>
    </Card>
  );
}

/** The compiler keeps no claims inventory; citation resolution is the traceability fact it does track. */
function TraceabilityPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { percent, detail, note } = traceability(wiki.pages);
  return (
    <Card title="Traceability">
      <div className="flex items-baseline justify-between gap-2">
        <strong className="text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">{percent}%</strong>
        <span className="text-sm text-zinc-500 tabular-nums dark:text-zinc-400">{detail}</span>
      </div>
      <meter min={0} max={100} value={percent} className="mt-2 h-2 w-full" />
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{note}</p>
    </Card>
  );
}

/** The health screen; `health` is the bootstrap payload shown until the per-visit refetch settles. */
export function HealthView({ wiki, health }: { wiki: PagesEnvelope; health: HealthPayload | null }): ReactNode {
  const fresh = useAsync(fetchHealth, "health");
  const current = fresh.status === "ready" ? fresh.data : health;
  const lint = current?.lint ?? null;
  const now = useMemo(() => new Date(), [current]);
  const pageIndex = useMemo(() => new Set(wiki.pages.map((page) => page.id)), [wiki]);
  return (
    <Screen wide title="Health" description={lintRunCaption(lint, now)}>
      <div className="space-y-6">
        <ContentsStrip health={current} wiki={wiki} />
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2"><LintPanel lint={lint} pageIndex={pageIndex} /></div>
          <div className="space-y-6">
            <ProblemsPanel wiki={wiki} />
            <FreshnessPanel wiki={wiki} />
            <TraceabilityPanel wiki={wiki} />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Lint results are cached from the last run. Re-run <Code>llmwiki lint</Code> and reload this page to refresh.</p>
          </div>
        </div>
      </div>
    </Screen>
  );
}
