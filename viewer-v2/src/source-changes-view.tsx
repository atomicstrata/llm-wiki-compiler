/**
 * The source review cockpit: an opt-in, read-only comparison of changed
 * sources with the current wiki page and its proposed updates. The server
 * reads every owning source on request, so the screen fetches per visit and
 * keeps nothing between visits. Everything from disk renders as text; the
 * only actions are a reload and a copyable terminal command, so no browser
 * path approves or applies anything.
 */
import { useState, type ReactNode } from "react";
import { fetchSourceChanges, type SourceChangeCandidate, type SourceChangePage, type SourceChangesReport, type SourceExcerpt } from "./api";
import { metadataBlock, ownerStatus, reviewCommand, reviewMessage } from "./source-changes-model";
import { useAsync } from "./use-async";

const CLIPBOARD_TIMEOUT_MS = 2000;
const EXCERPT_LIMIT = 20;

function TechnicalDetails({ text }: { text: string }): ReactNode {
  return <details className="technical-details"><summary>Technical details</summary><pre>{text}</pre></details>;
}

/** The initial metadata block moves into a disclosure; the exact text is retained. */
function DocumentText({ text, expandMetadata = false }: { text: string; expandMetadata?: boolean }): ReactNode {
  const metadata = metadataBlock(text);
  return (
    <div>
      {metadata && <details open={expandMetadata}><summary>Page metadata</summary><pre className="source-preview">{metadata}</pre></details>}
      <pre className="source-preview">{metadata ? text.slice(metadata.length) : text}</pre>
    </div>
  );
}

/** Clipboard only; the command never runs from here. */
function CommandCard({ root, id }: { root: string; id?: string }): ReactNode {
  const [status, setStatus] = useState("");
  const command = reviewCommand(root, id);
  const copy = async (): Promise<void> => {
    setStatus("Copying…");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Clipboard confirmation timed out")), CLIPBOARD_TIMEOUT_MS));
    try {
      await Promise.race([navigator.clipboard.writeText(command ?? ""), timeout]);
      setStatus("Copied — paste into your terminal. Nothing has run yet.");
    } catch {
      setStatus("Clipboard unavailable. Select and copy the command above manually.");
    }
  };
  return (
    <div className="sc-command">
      <p className="panel-caption">Project directory: {root || "unavailable"}</p>
      {id !== undefined && <p className="panel-caption">Proposal ID: {id}</p>}
      {command === null ? <p>A safe copyable command is unavailable. Reload the viewer or inspect this project manually.</p> : (
        <>
          <pre>{command}</pre>
          <p className="panel-caption">For macOS / Linux shells. Requires llmwiki on your PATH.</p>
          <button type="button" className="button" onClick={copy}>Copy terminal command</button>
          <span className="panel-caption" role="status">{status}</span>
        </>
      )}
    </div>
  );
}

/** Commands are instructions, not disguised mutation controls. */
function NextAction({ page, root, candidate }: { page: SourceChangePage; root: string; candidate?: SourceChangeCandidate }): ReactNode {
  const hasProposal = page.candidates.length > 0;
  return (
    <aside className="sc-next" aria-live="polite">
      <h2>{hasProposal ? "Next: review the proposed changes" : "Next: generate a proposed update"}</h2>
      <p className="panel-caption">Selected page: {page.title}</p>
      <p>{hasProposal
        ? "Compare the panels below, then copy and run this command in your terminal to inspect the selected proposal. This does not approve or apply it."
        : "No update targets this page. Generate proposals in your project terminal, then check files again. Generation uses your configured provider and can update compiler bookkeeping; it does not approve changes."}</p>
      <CommandCard root={root} id={candidate?.id} />
    </aside>
  );
}

/** Changed sources open by default; stable text stays collapsible. */
function Excerpt({ excerpt, status }: { excerpt: SourceExcerpt; status: string }): ReactNode {
  return (
    <details open={status === "changed"}>
      <summary>{excerpt.file} · {status}</summary>
      <pre className="source-preview">{excerpt.text ?? `Preview unavailable: ${excerpt.status}`}</pre>
      {excerpt.truncated && <p>Excerpt shortened. Inspect the full source before deciding.</p>}
    </details>
  );
}

function Proposal({ candidate, metadataChanged }: { candidate: SourceChangeCandidate; metadataChanged: boolean }): ReactNode {
  return (
    <details open>
      {metadataChanged && <p className="sc-notice">This proposal changes page metadata. Review the expanded metadata in both panels.</p>}
      <summary>Proposed wiki text · {candidate.id} · not applied</summary>
      <p>{reviewMessage(candidate)}</p>
      <TechnicalDetails text={`Target: ${candidate.checks.target}; sources: ${candidate.checks.sources}`} />
      <DocumentText text={candidate.body} expandMetadata={metadataChanged} />
      {candidate.truncated && <p>Proposal shortened. Inspect its full body before review.</p>}
    </details>
  );
}

interface ComparisonProps {
  page: SourceChangePage;
  candidate?: SourceChangeCandidate;
  onChoose: (index: number) => void;
}

/** Provenance and sources come before generated text in the reading order. */
function PageComparison({ page, candidate, onChoose }: ComparisonProps): ReactNode {
  const metadataChanged = candidate !== undefined && metadataBlock(page.current) !== metadataBlock(candidate.body);
  return (
    <section className="sc-comparison">
      <h2>{page.title}</h2>
      <p className="panel-caption">{page.impact}</p>
      {page.reconciliationPending && <p>Compiler reconciliation marker present; this is not a human edit lock.</p>}
      <div className="sc-panels">
        <section className="panel sc-evidence">
          <h3>01 · Source evidence</h3><p className="panel-caption">Current excerpts · not a historical diff</p>
          {page.excerpts.map((excerpt) => <Excerpt key={excerpt.file} excerpt={excerpt} status={ownerStatus(excerpt, page.owners)} />)}
          {page.excerpts.length < page.owners.length && <p>Only the first {EXCERPT_LIMIT} contributor previews are shown.</p>}
        </section>
        <section className="panel">
          <h3>02 · Current wiki</h3><p className="panel-caption">Saved page · unchanged by this screen</p>
          <DocumentText text={page.current ?? page.readStatus} expandMetadata={metadataChanged} />
          {page.truncated && <p>Wiki text shortened; inspect the full file before review.</p>}
        </section>
        <section className="panel sc-proposed">
          <h3>03 · Proposed update</h3>
          {candidate === undefined ? <p>No proposed update. Generation is a separate, explicit compiler action.</p> : (
            <>
              <select className="sc-proposal-select" aria-label="Proposal to inspect" value={candidate.id} onChange={(event) => onChoose(event.target.selectedIndex)}>
                {page.candidates.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}
              </select>
              <Proposal candidate={candidate} metadataChanged={metadataChanged} />
            </>
          )}
        </section>
      </div>
    </section>
  );
}

/** Counts describe this bounded observation, never global completion. */
function Metrics({ report }: { report: SourceChangesReport }): ReactNode {
  const withoutProposal = report.pages.filter((page) => page.candidates.length === 0).length;
  const cards: [string, string][] = [
    [`${report.pages.length} of ${report.totalPages}`, "Pages shown"],
    [`${report.candidateShown} of ${report.candidateTotal}`, "Proposals / pending records"],
    [String(withoutProposal), "Without a proposal"],
    ["CLI only", "Approval & apply"],
  ];
  return (
    <div className="stat-grid">
      {cards.map(([value, label]) => <div key={label} className="stat-card"><strong className="stat-value">{value}</strong><span className="stat-sub">{label}</span></div>)}
    </div>
  );
}

/** One selection at a time keeps the queue and the comparison in a stable workspace. */
function Workspace({ report }: { report: SourceChangesReport }): ReactNode {
  const [selected, setSelected] = useState({ page: 0, candidate: 0 });
  const page = report.pages[selected.page];
  const candidate = page?.candidates[selected.candidate];
  return (
    <>
      {page && <NextAction page={page} root={report.projectRoot} candidate={candidate} />}
      <div className="sc-workspace">
        <nav className="sc-queue" aria-label="Pages needing review">
          <h2>Review queue</h2>
          {report.pages.map((row, index) => (
            <button key={row.slug} type="button" className="sc-queue-item" aria-pressed={index === selected.page} onClick={() => setSelected({ page: index, candidate: 0 })}>
              <strong>{row.title}</strong><span>{row.impact}</span>
              <small>{row.candidates.length} proposal(s) · {row.owners.length} source(s)</small>
            </button>
          ))}
        </nav>
        <div className="sc-detail">
          {page && <PageComparison page={page} candidate={candidate} onChoose={(index) => setSelected({ ...selected, candidate: index })} />}
        </div>
      </div>
    </>
  );
}

/** One fresh bounded observation, with its limits and the next CLI action. */
export function SourceCockpit({ report }: { report: SourceChangesReport }): ReactNode {
  return (
    <div className="source-cockpit">
      <header className="sc-header">
        <span className="contents-eyebrow">KNOWLEDGE MAINTENANCE · READ-ONLY PREVIEW</span>
        <h1>Source review cockpit</h1>
        <p>Choose a page. Compare its evidence. Decide what needs attention before CLI review.</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>Check files again</button>
      </header>
      <p className="sc-notice">Inspection only — proposals are not approved. Content origin is not authenticated by this view; local data may include authored examples.</p>
      <Metrics report={report} />
      {report.stateStatus !== "ok" && <p className="status">Compilation state is unavailable. No freshness conclusion can be drawn.</p>}
      <Workspace report={report} />
      {report.pages.length === 0 && <p>No supported affected pages or proposals found in this bounded observation.</p>}
      <TechnicalDetails text={`Observed ${report.observedAt}. State: ${report.stateStatus}. Showing ${report.pages.length} of ${report.totalPages} pages; ${report.candidateShown} supported proposals from ${report.candidateTotal} pending records.`} />
    </div>
  );
}

/** The source-changes screen: loading, not enabled, unavailable, or the cockpit. */
export function SourceChangesView(): ReactNode {
  const state = useAsync(fetchSourceChanges, "source-changes");
  if (state.status === "loading") return <p className="status">Reading current sources and proposals…</p>;
  if (state.status === "error") {
    return <p className="status status-error" role="alert">Source comparison is unavailable or not enabled. No previous comparison is retained. Reload to retry.</p>;
  }
  if (state.data === null) {
    return (
      <section>
        <h1>Source changes</h1>
        <p className="status">Source comparison is not enabled on this viewer. It is an opt-in server option that only answers on a loopback address; the Reviews screen links here when it is on.</p>
      </section>
    );
  }
  return <SourceCockpit report={state.data} />;
}
