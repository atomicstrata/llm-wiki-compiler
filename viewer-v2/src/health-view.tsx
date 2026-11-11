/**
 * The health screen: is anything wrong, what is it, and where. A head with
 * the lint caption, the CONTENTS strip of inert counts, then the Lint panel
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
import { Badge, Card, Code, RowList, Screen, Table, Td, TextLink, type Tone } from "./components";
import {
  contentsColumns, countFigure, freshnessSummary, lintFooter, lintRuleRows, lintRunCaption, problemsSummary, traceability,
  type FreshnessSummary, type LintFooter, type LintRow,
} from "./health-model";
import { useAsync } from "./use-async";

const RULE_COLUMNS = ["RULE", "MOST AFFECTED", "COUNT", "FIX"];

/** How each freshness verdict reads as a badge. */
const FRESHNESS_TONE: Record<FreshnessSummary["badge"]["tone"], Tone> = { ok: "green", warn: "amber", unknown: "neutral" };

function ContentsStrip({ health, wiki }: { health: HealthPayload | null; wiki: PagesEnvelope }): ReactNode {
  return (
    <Card title="Contents" action={<span className="text-xs text-zinc-500 dark:text-zinc-400">counts only — nothing here is a problem</span>}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {contentsColumns(health, wiki).map((column) => (
          <div key={column.key} data-contents={column.key}>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{column.label}</dt>{" "}
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">{countFigure(column.value)}</dd>{" "}
            <dd className="text-xs text-zinc-500 dark:text-zinc-400">{column.suffix}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The colour treatment a bar segment, legend swatch and rule name share. */
function rankAttribute(row: LintRow): string | undefined {
  return row.rank === null ? undefined : String(row.rank);
}

/** Errors read red and warnings amber only while there are some; zero stays neutral. */
function LintSummaryBand({ lint }: { lint: LintSummary }): ReactNode {
  const figures: [string, number, string, string][] = [
    ["errors", lint.errors, "error", lint.errors > 0 ? "text-red-600 dark:text-red-400" : "text-zinc-950 dark:text-white"],
    ["warnings", lint.warnings, "warning", lint.warnings > 0 ? "text-amber-600 dark:text-amber-400" : "text-zinc-950 dark:text-white"],
  ];
  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      {figures.map(([key, count, noun, colour]) => (
        <div key={key} className="flex items-baseline gap-2">
          <span className={`text-3xl font-semibold tracking-tight tabular-nums ${colour}`}>{count}</span>{" "}
          <span className="text-sm text-zinc-500 dark:text-zinc-400">{noun}{count === 1 ? "" : "s"}</span>
        </div>
      ))}
    </div>
  );
}

/** A link only when the flagged file is a page this viewer renders; a link that 404s is worse than none. */
function RuleRow({ row }: { row: LintRow }): ReactNode {
  return (
    <tr data-rule={row.rule}>
      <Td data-rank={rankAttribute(row)}><span className="font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100">{row.rule}</span></Td>
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
      <span>{footer.insight}</span>{" "}
      {footer.action && <TextLink href={footer.action.href}>{footer.action.label}</TextLink>}
    </>
  );
}

/** Warm-framed only while there is something to act on; never run is a real, common state, not an error. */
function LintPanel({ lint, pageIndex }: { lint: LintSummary | null; pageIndex: Set<string> }): ReactNode {
  const total = lint === null ? null : lint.errors + lint.warnings;
  const hasProblems = total !== null && total > 0;
  const footer = lint === null ? null : lintFooter(lint.rules ?? [], lint.errors + lint.warnings, pageIndex);
  return (
    <div data-lint-panel="">
      <Card flush title="Lint" action={total !== null && <Badge tone={hasProblems ? "amber" : "green"}>{total} PROBLEMS</Badge>}
        footer={footer && <LintFooterLine footer={footer} />}>
        {lint === null
          ? <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">No cached lint summary yet — run <Code>llmwiki lint</Code>.</p>
          : <LintBody lint={lint} pageIndex={pageIndex} />}
      </Card>
    </div>
  );
}

/** Only exists when the profile collector reported something; a default project has nothing to be empty about. */
function ProblemsPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { rows, total, notice } = problemsSummary(wiki);
  if (rows.length === 0) return null;
  return (
    <div data-profile-panel="">
      <Card flush title="Record problems" action={<Badge tone="amber">{total} {total === 1 ? "PROBLEM" : "PROBLEMS"}</Badge>}
        footer={notice && <span>{notice}</span>}>
        <RowList>
          {rows.map((row, index) => (
            <li key={index} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <strong className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</strong>{" "}
                {row.where && <span className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">{row.where}</span>}
              </div>
              <p className="text-zinc-700 dark:text-zinc-300">{row.message}</p>
              <details className="text-xs text-zinc-500 dark:text-zinc-400">
                <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-200">Technical details</summary>
                <pre className="mt-1 font-mono">Problem code: {row.code}</pre>
              </details>
            </li>
          ))}
        </RowList>
      </Card>
    </div>
  );
}

function FreshnessPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { badge, note } = freshnessSummary(wiki.pages.filter((page) => page.pageDirectory === "concepts"));
  return (
    <div data-freshness-panel="">
      <Card title="Freshness" action={<Badge tone={FRESHNESS_TONE[badge.tone]}>{badge.text}</Badge>}>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">{note}</p>
      </Card>
    </div>
  );
}

/** The compiler keeps no claims inventory; citation resolution is the traceability fact it does track. */
function TraceabilityPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { percent, detail, note } = traceability(wiki.pages);
  return (
    <div data-traceability-panel="">
      <Card title="Traceability">
        <div className="flex items-baseline justify-between gap-2">
          <strong className="text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">{percent}%</strong>{" "}
          <span className="text-sm text-zinc-500 tabular-nums dark:text-zinc-400">{detail}</span>
        </div>
        <meter min={0} max={100} value={percent} className="mt-2 h-2 w-full" />
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{note}</p>
      </Card>
    </div>
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
