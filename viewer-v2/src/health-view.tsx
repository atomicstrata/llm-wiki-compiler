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
import {
  contentsColumns, countFigure, freshnessSummary, lintFooter, lintRuleRows, lintRunCaption, problemsSummary, traceability,
  type LintRow,
} from "./health-model";
import { useAsync } from "./use-async";

const RULE_COLUMNS = ["RULE", "MOST AFFECTED", "COUNT", "FIX"];

function ContentsStrip({ health, wiki }: { health: HealthPayload | null; wiki: PagesEnvelope }): ReactNode {
  return (
    <div className="contents-strip">
      <div className="contents-head"><span className="contents-eyebrow">CONTENTS</span><span className="panel-caption">counts only — nothing here is a problem</span></div>
      <div className="contents-columns">
        {contentsColumns(health, wiki).map((column) => (
          <div key={column.key} className="contents-cell" data-contents={column.key}>
            <span className="contents-label">{column.label}</span>
            <span className={`contents-value${column.value > 0 ? "" : " is-zero"}`}>{countFigure(column.value)}</span>
            <span className="contents-suffix">{column.suffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The colour treatment a bar segment, legend swatch and rule name share. */
function rankAttributes(row: LintRow): { className: string; "data-rank"?: string } {
  return row.rank === null ? { className: "is-other" } : { className: "", "data-rank": String(row.rank) };
}

function LintSummaryBand({ lint, rows }: { lint: LintSummary; rows: LintRow[] }): ReactNode {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const figures: [string, number, string][] = [["errors", lint.errors, "error"], ["warnings", lint.warnings, "warning"]];
  return (
    <div className="lint-summary">
      <div className="lint-totals">
        {figures.map(([key, count, noun]) => (
          <div key={key} className="lint-figure-row"><span className={`lint-figure is-${key}`}>{count}</span><span className="lint-figure-label">{noun}{count === 1 ? "" : "s"}</span></div>
        ))}
      </div>
      <div className="lint-breakdown">
        <div className="lint-bar">
          {total > 0 && rows.map((row) => {
            const rank = rankAttributes(row);
            return <div key={row.rule} className={`lint-bar-seg ${rank.className}`} data-rank={rank["data-rank"]} style={{ width: `${(row.count / total) * 100}%` }} />;
          })}
        </div>
        <div className="lint-legend">
          {rows.map((row) => {
            const rank = rankAttributes(row);
            return <span key={row.rule} className="lint-legend-item"><span className={`lint-swatch ${rank.className}`} data-rank={rank["data-rank"]} />{row.rule} {row.count}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

/** A link only when the flagged file is a page this viewer renders; a link that 404s is worse than none. */
function RuleRow({ row }: { row: LintRow }): ReactNode {
  const rank = rankAttributes(row);
  return (
    <div className="lint-row" data-rule={row.rule}>
      <span className={`lint-rule ${rank.className}`} data-rank={rank["data-rank"]}>{row.rule}</span>
      <span className="lint-affected">{row.affected}</span>
      <span className="lint-count">{row.count}</span>
      {row.href === null ? <span className="lint-fix is-plain">—</span> : <a className="lint-fix" href={row.href}>view →</a>}
    </div>
  );
}

/** The rule table and the footer naming the dominant rule; nothing on a clean run. */
function LintBody({ lint, pageIndex }: { lint: LintSummary; pageIndex: Set<string> }): ReactNode {
  const rules = lint.rules ?? [];
  const rows = lintRuleRows(rules, pageIndex);
  const footer = lintFooter(rules, lint.errors + lint.warnings, pageIndex);
  return (
    <>
      <LintSummaryBand lint={lint} rows={rows} />
      {rows.length > 0 && (
        <div className="lint-table">
          <div className="lint-row is-head">{RULE_COLUMNS.map((label) => <span key={label}>{label}</span>)}</div>
          {rows.map((row) => <RuleRow key={row.rule} row={row} />)}
        </div>
      )}
      {footer && (
        <div className="lint-footer">
          <span className="lint-insight">{footer.insight}</span>
          {footer.action && <a className="button" href={footer.action.href}>{footer.action.label}</a>}
        </div>
      )}
    </>
  );
}

/** Warm-framed only while there is something to act on; never run is a real, common state, not an error. */
function LintPanel({ lint, pageIndex }: { lint: LintSummary | null; pageIndex: Set<string> }): ReactNode {
  const total = lint === null ? null : lint.errors + lint.warnings;
  const hasProblems = total !== null && total > 0;
  return (
    <section className={`panel lint-panel${hasProblems ? " has-problems" : ""}`} data-lint-panel="">
      <div className="panel-head"><span className="panel-title">Lint</span>{total !== null && <span className="lint-chip">{total} PROBLEMS</span>}</div>
      {lint === null ? <p className="status">No cached lint summary yet — run <code>llmwiki lint</code>.</p> : <LintBody lint={lint} pageIndex={pageIndex} />}
    </section>
  );
}

/** Only exists when the profile collector reported something; a default project has nothing to be empty about. */
function ProblemsPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { rows, total, notice } = problemsSummary(wiki);
  if (rows.length === 0) return null;
  return (
    <section className="panel" data-profile-panel="">
      <div className="panel-head"><span className="panel-title">Record problems</span><span className="pill is-warn">{total} {total === 1 ? "PROBLEM" : "PROBLEMS"}</span></div>
      <ul className="problem-list">
        {rows.map((row, index) => (
          <li key={index} className="problem-row">
            <div className="problem-head"><strong>{row.label}</strong>{row.where && <span className="problem-where">{row.where}</span>}</div>
            <p>{row.message}</p>
            <details className="technical-details"><summary>Technical details</summary><pre>Problem code: {row.code}</pre></details>
          </li>
        ))}
      </ul>
      {notice && <p className="panel-caption">{notice}</p>}
    </section>
  );
}

function FreshnessPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { bars, badge, note } = freshnessSummary(wiki.pages.filter((page) => page.pageDirectory === "concepts"));
  return (
    <section className="panel" data-freshness-panel="">
      <div className="panel-head"><span className="panel-title">Freshness</span><span className={`pill is-${badge.tone}`}>{badge.text}</span></div>
      <div className="freshness-bars">{bars.map((status, index) => <span key={index} className={`freshness-bar is-${status}`} />)}</div>
      <p className="panel-caption">{note}</p>
    </section>
  );
}

/** The compiler keeps no claims inventory; citation resolution is the traceability fact it does track. */
function TraceabilityPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { percent, detail, note } = traceability(wiki.pages);
  return (
    <section className="panel" data-traceability-panel="">
      <div className="panel-head"><span className="panel-title">Traceability</span></div>
      <div className="trace-head"><strong className="stat-value">{percent}%</strong><span className="trace-detail">{detail}</span></div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${percent}%` }} /></div>
      <p className="panel-caption">{note}</p>
    </section>
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
    <div className="health-view">
      <div className="health-head"><h1>Health</h1><span className="health-lint-run">{lintRunCaption(lint, now)}</span></div>
      <ContentsStrip health={current} wiki={wiki} />
      <div className="health-grid">
        <LintPanel lint={lint} pageIndex={pageIndex} />
        <div className="health-column">
          <ProblemsPanel wiki={wiki} />
          <FreshnessPanel wiki={wiki} />
          <TraceabilityPanel wiki={wiki} />
          <p className="panel-caption">Lint results are cached from the last run. Re-run <code>llmwiki lint</code> and reload this page to refresh.</p>
        </div>
      </div>
    </div>
  );
}
