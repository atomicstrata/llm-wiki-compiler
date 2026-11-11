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
    <div>
      <div><span>CONTENTS</span>{" "}<span>counts only — nothing here is a problem</span></div>
      <div>
        {contentsColumns(health, wiki).map((column) => (
          <div key={column.key} data-contents={column.key}>
            <span>{column.label}</span>{" "}
            <span>{countFigure(column.value)}</span>{" "}
            <span>{column.suffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The colour treatment a bar segment, legend swatch and rule name share. */
function rankAttribute(row: LintRow): string | undefined {
  return row.rank === null ? undefined : String(row.rank);
}

function LintSummaryBand({ lint }: { lint: LintSummary }): ReactNode {
  const figures: [string, number, string][] = [["errors", lint.errors, "error"], ["warnings", lint.warnings, "warning"]];
  return (
    <div>
      {figures.map(([key, count, noun]) => (
        <div key={key}><span>{count}</span>{" "}<span>{noun}{count === 1 ? "" : "s"}</span></div>
      ))}
    </div>
  );
}

/** A link only when the flagged file is a page this viewer renders; a link that 404s is worse than none. */
function RuleRow({ row }: { row: LintRow }): ReactNode {
    return (
    <tr data-rule={row.rule}>
      <td data-rank={rankAttribute(row)}>{row.rule}</td>
      <td>{row.affected}</td>
      <td>{row.count}</td>
      <td>{row.href === null ? "—" : <a href={row.href}>view →</a>}</td>
    </tr>
  );
}

/** The rule table and the footer naming the dominant rule; nothing on a clean run. */
function LintBody({ lint, pageIndex }: { lint: LintSummary; pageIndex: Set<string> }): ReactNode {
  const rules = lint.rules ?? [];
  const rows = lintRuleRows(rules, pageIndex);
  const footer = lintFooter(rules, lint.errors + lint.warnings, pageIndex);
  return (
    <>
      <LintSummaryBand lint={lint} />
      {rows.length > 0 && (
        <table>
          <thead><tr>{RULE_COLUMNS.map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <RuleRow key={row.rule} row={row} />)}</tbody>
        </table>
      )}
      {footer && (
        <div>
          <span>{footer.insight}</span>{" "}
          {footer.action && <a href={footer.action.href}>{footer.action.label}</a>}
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
    <section data-lint-panel="">
      <div><span>Lint</span>{" "}{total !== null && <span>{total} PROBLEMS</span>}</div>
      {lint === null ? <p>No cached lint summary yet — run <code>llmwiki lint</code>.</p> : <LintBody lint={lint} pageIndex={pageIndex} />}
    </section>
  );
}

/** Only exists when the profile collector reported something; a default project has nothing to be empty about. */
function ProblemsPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { rows, total, notice } = problemsSummary(wiki);
  if (rows.length === 0) return null;
  return (
    <section data-profile-panel="">
      <div><span>Record problems</span>{" "}<span>{total} {total === 1 ? "PROBLEM" : "PROBLEMS"}</span></div>
      <ul>
        {rows.map((row, index) => (
          <li key={index}>
            <div><strong>{row.label}</strong>{" "}{row.where && <span>{row.where}</span>}</div>
            <p>{row.message}</p>
            <details><summary>Technical details</summary><pre>Problem code: {row.code}</pre></details>
          </li>
        ))}
      </ul>
      {notice && <p>{notice}</p>}
    </section>
  );
}

function FreshnessPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { badge, note } = freshnessSummary(wiki.pages.filter((page) => page.pageDirectory === "concepts"));
  return (
    <section data-freshness-panel="">
      <div><span>Freshness</span>{" "}<span>{badge.text}</span></div>
      <p>{note}</p>
    </section>
  );
}

/** The compiler keeps no claims inventory; citation resolution is the traceability fact it does track. */
function TraceabilityPanel({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const { percent, detail, note } = traceability(wiki.pages);
  return (
    <section data-traceability-panel="">
      <div><span>Traceability</span></div>
      <div><strong>{percent}%</strong>{" "}<span>{detail}</span></div>
      <meter min={0} max={100} value={percent} />
      <p>{note}</p>
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
    <div>
      <div><h1>Health</h1><span>{lintRunCaption(lint, now)}</span></div>
      <ContentsStrip health={current} wiki={wiki} />
      <div>
        <LintPanel lint={lint} pageIndex={pageIndex} />
        <div>
          <ProblemsPanel wiki={wiki} />
          <FreshnessPanel wiki={wiki} />
          <TraceabilityPanel wiki={wiki} />
          <p>Lint results are cached from the last run. Re-run <code>llmwiki lint</code> and reload this page to refresh.</p>
        </div>
      </div>
    </div>
  );
}
