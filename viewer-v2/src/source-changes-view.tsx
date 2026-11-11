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
import { AsyncView } from "./async-view";
import { Badge, Button, Card, CodeBlock, Disclosure, EmptyState, Notice, RowList, Screen, SelectField, Stat } from "./components";
import { metadataBlock, ownerStatus, reviewCommand, reviewMessage } from "./source-changes-model";
import { useAsync } from "./use-async";
import { plural } from "./wiki-model";

const CLIPBOARD_TIMEOUT_MS = 2000;

/** A quiet secondary line. */
function Note({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-xs text-zinc-500 dark:text-zinc-400">{children}</p>;
}

function TechnicalDetails({ text }: { text: string }): ReactNode {
  return <Disclosure summary="Technical details"><CodeBlock>{text}</CodeBlock></Disclosure>;
}

/** The initial metadata block moves into a disclosure; the exact text is retained. */
function DocumentText({ text, expandMetadata = false }: { text: string; expandMetadata?: boolean }): ReactNode {
  const metadata = metadataBlock(text);
  return (
    <div className="space-y-2">
      {metadata && <Disclosure summary="Page metadata" open={expandMetadata}><CodeBlock>{metadata}</CodeBlock></Disclosure>}
      <CodeBlock>{metadata ? text.slice(metadata.length) : text}</CodeBlock>
    </div>
  );
}

/** The copyable command, its caveats, and the copy button with its status line. */
function CopyableCommand({ command }: { command: string }): ReactNode {
  const [status, setStatus] = useState("");
  const copy = async (): Promise<void> => {
    setStatus("Copying…");
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Clipboard confirmation timed out")), CLIPBOARD_TIMEOUT_MS));
    try {
      await Promise.race([navigator.clipboard.writeText(command), timeout]);
      setStatus("Copied — paste into your terminal. Nothing has run yet.");
    } catch {
      setStatus("Clipboard unavailable. Select and copy the command above manually.");
    }
  };
  return (
    <>
      <CodeBlock>{command}</CodeBlock>
      <Note>For macOS / Linux shells. Requires llmwiki on your PATH.</Note>
      <div className="flex items-center gap-3">
        <Button onClick={copy}>Copy terminal command</Button>
        <span role="status" className="text-xs text-zinc-500 dark:text-zinc-400">{status}</span>
      </div>
    </>
  );
}

/** Clipboard only; the command never runs from here. */
function CommandCard({ root, id }: { root: string; id?: string }): ReactNode {
  const command = reviewCommand(root, id);
  return (
    <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-300">
      <p>Project directory: <span className="font-mono text-xs break-all">{root || "unavailable"}</span></p>
      {id !== undefined && <p>Proposal ID: {id}</p>}
      {command === null
        ? <Notice>A safe copyable command is unavailable. Reload the viewer or inspect this project manually.</Notice>
        : <CopyableCommand command={command} />}
    </div>
  );
}

/** Commands are instructions, not disguised mutation controls. */
function NextAction({ page, root, candidate }: { page: SourceChangePage; root: string; candidate?: SourceChangeCandidate }): ReactNode {
  const hasProposal = page.candidates.length > 0;
  return (
    <aside aria-label="Next action">
      <Card title={hasProposal ? "Next: review the proposed changes" : "Next: generate a proposed update"}>
        <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-300">
          <p>Selected page: <span className="font-medium text-zinc-900 dark:text-zinc-100">{page.title}</span></p>
          <p>{hasProposal
            ? "Compare the panels below, then copy and run this command in your terminal to inspect the selected proposal. This does not approve or apply it."
            : "No update targets this page. Generate proposals in your project terminal, then check files again. Generation uses your configured provider and can update compiler bookkeeping; it does not approve changes."}</p>
          <CommandCard root={root} id={candidate?.id} />
        </div>
      </Card>
    </aside>
  );
}

/** Changed sources open by default; stable text stays collapsible. */
function Excerpt({ excerpt, status }: { excerpt: SourceExcerpt; status: string }): ReactNode {
  return (
    <Disclosure summary={`${excerpt.file} · ${status}`} open={status === "changed"}>
      <CodeBlock>{excerpt.text ?? `Preview unavailable: ${excerpt.status}`}</CodeBlock>
      {excerpt.truncated && <Note>Excerpt shortened. Inspect the full source before deciding.</Note>}
    </Disclosure>
  );
}

function Proposal({ candidate, metadataChanged }: { candidate: SourceChangeCandidate; metadataChanged: boolean }): ReactNode {
  return (
    <Disclosure summary={`Proposed wiki text · ${candidate.id} · not applied`} open>
      {metadataChanged && <Notice>This proposal changes page metadata. Review the expanded metadata in both panels.</Notice>}
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{reviewMessage(candidate)}</p>
      <TechnicalDetails text={`Target: ${candidate.checks.target}; sources: ${candidate.checks.sources}`} />
      <DocumentText text={candidate.body} expandMetadata={metadataChanged} />
      {candidate.truncated && <Note>Proposal shortened. Inspect its full body before review.</Note>}
    </Disclosure>
  );
}

/** One numbered comparison panel: its heading, a caption, then its content. */
function ComparisonPanel({ heading, caption, children }: { heading: string; caption?: string; children: ReactNode }): ReactNode {
  return (
    <Card>
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">{heading}</h3>
          {caption && <Note>{caption}</Note>}
        </div>
        {children}
      </div>
    </Card>
  );
}

interface ComparisonProps {
  page: SourceChangePage;
  candidate?: SourceChangeCandidate;
  onChoose: (index: number) => void;
}

/** The proposal picker and the chosen proposal, or the note that none exists. */
function ProposedPanel({ page, candidate, onChoose, metadataChanged }: ComparisonProps & { metadataChanged: boolean }): ReactNode {
  return (
    <ComparisonPanel heading="03 · Proposed update">
      {candidate === undefined ? <p className="text-sm text-zinc-500 dark:text-zinc-400">No proposed update. Generation is a separate, explicit compiler action.</p> : (
        <>
          <SelectField label="Proposal to inspect" value={candidate.id} onChange={(id) => onChoose(page.candidates.findIndex((row) => row.id === id))}>
            {page.candidates.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}
          </SelectField>
          <Proposal candidate={candidate} metadataChanged={metadataChanged} />
        </>
      )}
    </ComparisonPanel>
  );
}

/** Provenance and sources come before generated text in the reading order. */
function PageComparison(props: ComparisonProps): ReactNode {
  const { page, candidate } = props;
  const metadataChanged = candidate !== undefined && metadataBlock(page.current) !== metadataBlock(candidate.body);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-white">{page.title}</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{page.impact}</p>
      </div>
      {page.reconciliationPending && <Notice>Compiler reconciliation marker present; this is not a human edit lock.</Notice>}
      <ComparisonPanel heading="01 · Source evidence" caption="Current excerpts · not a historical diff">
        {page.excerpts.map((excerpt) => <Excerpt key={excerpt.file} excerpt={excerpt} status={ownerStatus(excerpt, page.owners)} />)}
        {page.excerpts.length < page.owners.length && <Note>Only the first {page.excerpts.length} of {page.owners.length} contributor previews are shown.</Note>}
      </ComparisonPanel>
      <ComparisonPanel heading="02 · Current wiki" caption="Saved page · unchanged by this screen">
        <DocumentText text={page.current ?? page.readStatus} expandMetadata={metadataChanged} />
        {page.truncated && <Note>Wiki text shortened; inspect the full file before review.</Note>}
      </ComparisonPanel>
      <ProposedPanel {...props} metadataChanged={metadataChanged} />
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
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map(([value, label]) => <Stat key={label} label={label} value={value} />)}
    </div>
  );
}

/** The pages to choose from; the pressed row is the one being compared. */
function ReviewQueue({ report, selected, onSelect }: { report: SourceChangesReport; selected: number; onSelect: (index: number) => void }): ReactNode {
  return (
    <nav aria-label="Pages needing review">
      <Card flush title="Review queue">
        <RowList>
          {report.pages.map((row, index) => (
            <li key={row.slug}>
              <button type="button" aria-pressed={index === selected} onClick={() => onSelect(index)}
                className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left text-sm hover:bg-zinc-50 aria-pressed:bg-indigo-50 dark:hover:bg-white/5 dark:aria-pressed:bg-indigo-500/10">
                <strong className="font-medium text-zinc-900 dark:text-zinc-100">{row.title}</strong>
                <span className="text-zinc-600 dark:text-zinc-300">{row.impact}</span>
                <small className="text-xs text-zinc-500 dark:text-zinc-400">{plural(row.candidates.length, "proposal")} · {plural(row.owners.length, "source")}</small>
              </button>
            </li>
          ))}
        </RowList>
      </Card>
    </nav>
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
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <ReviewQueue report={report} selected={selected.page} onSelect={(index) => setSelected({ page: index, candidate: 0 })} />
        <div className="lg:col-span-2">
          {page && <PageComparison page={page} candidate={candidate} onChoose={(index) => setSelected((current) => ({ ...current, candidate: index }))} />}
        </div>
      </div>
    </>
  );
}

/** One fresh bounded observation, with its limits and the next CLI action. */
export function SourceCockpit({ report }: { report: SourceChangesReport }): ReactNode {
  return (
    <Screen wide title="Source review cockpit"
      description="Choose a page. Compare its evidence. Decide what needs attention before CLI review."
      actions={<><Badge tone="indigo">READ-ONLY PREVIEW</Badge><Button onClick={() => window.location.reload()}>Check files again</Button></>}>
      <div className="space-y-6">
        <Note>Inspection only — proposals are not approved. Content origin is not authenticated by this view; local data may include authored examples.</Note>
        <Metrics report={report} />
        {report.stateStatus !== "ok" && <Notice>Compilation state is unavailable. No freshness conclusion can be drawn.</Notice>}
        {report.pages.length === 0
          ? <EmptyState title="Nothing to review" body="No supported affected pages or proposals found in this bounded observation." />
          : <Workspace report={report} />}
        <TechnicalDetails text={`Observed ${report.observedAt}. State: ${report.stateStatus}. Showing ${report.pages.length} of ${report.totalPages} pages; ${report.candidateShown} supported proposals from ${report.candidateTotal} pending records.`} />
      </div>
    </Screen>
  );
}

/** Shown when the server has source comparison switched off. */
function NotEnabled(): ReactNode {
  return (
    <Screen title="Source changes">
      <p className="text-sm text-zinc-600 dark:text-zinc-300">Source comparison is not enabled on this viewer. It is an opt-in server option that only answers on a loopback address; the Reviews screen links here when it is on.</p>
    </Screen>
  );
}

/** The source-changes screen: loading, unavailable, not enabled, or the cockpit. */
export function SourceChangesView(): ReactNode {
  const state = useAsync(fetchSourceChanges, "source-changes");
  return (
    <AsyncView state={state} loading="Reading current sources and proposals…"
      error="Source comparison is unavailable or not enabled. No previous comparison is retained. Reload to retry.">
      {(report) => (report === null ? <NotEnabled /> : <SourceCockpit report={report} />)}
    </AsyncView>
  );
}
