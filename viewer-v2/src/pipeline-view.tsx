/**
 * The lifecycle status screen: one row per declared entity type with what its
 * lifecycle is, where its pages sit, and what the gap between the two numbers
 * means; then the relation and artifact types the profile declares, and the
 * validation problems the server reported. Colour never carries a finding on
 * its own: an unreachable chip says "unreachable" in words.
 *
 * Time in state is deliberately absent. Nothing records when a page entered
 * its state, and a file mtime answers a different question.
 */
import type { ReactNode } from "react";
import type { ArtifactTypeDef, EntityTypeRow, PagesEnvelope, PipelineLifecycle, RelationTypeRow } from "./api";
import { EmptyState } from "./lists";
import {
  calloutText, chipLabel, classifyStates, declaredText, displayLabel, displayedStates, footerText, gapText,
  hasDeclaredOrder, reachableOrder, rowVerdict, totalRejected, type StateTally,
} from "./pipeline-model";
import { plural, typeLabel } from "./wiki-model";

const COLUMN_HEADS = ["CATEGORY · DECLARED LIFECYCLE", "RECORDS BY CURRENT STATE", "STATE CHECK"];
const LINT_HREF = "#/health";

/** Left column: the type's name and valid page count, then what it declares. */
function TypeCell({ row }: { row: EntityTypeRow }): ReactNode {
  const chain = reachableOrder(row.lifecycle);
  return (
    <div className="pipeline-type">
      <div className="pipeline-type-head">
        <span className="pipeline-type-name">{typeLabel(row.type)}</span>
        <span className="pipeline-type-count">{row.pageCount}</span>
      </div>
      <div className="pipeline-directory">{row.directory}</div>
      {hasDeclaredOrder(row.lifecycle) && chain.length > 1 && <div className="pipeline-chain">{chain.join(" → ")}</div>}
      <div className="pipeline-declared">{declaredText(row.lifecycle)}</div>
    </div>
  );
}

/** One state chip: swatch, count, name, and the role when it matters. */
function Chip({ state }: { state: StateTally }): ReactNode {
  return (
    <span className={`pipeline-chip is-${state.role}`} data-state={state.state}>
      {state.count > 0 && <span className={`pipeline-swatch is-${state.role}`} style={{ opacity: state.alpha }} />}
      <span>{chipLabel(state)}</span>
    </span>
  );
}

/** Middle column: every state with its count, and a callout per unreachable state. */
function TallyCell({ row, states }: { row: EntityTypeRow; states: StateTally[] }): ReactNode {
  const unreachable = states.filter((entry) => entry.role === "unreachable");
  return (
    <div className="pipeline-tally">
      {states.length === 0 && <div className="pipeline-none">{row.pageCount > 0 ? "No records have a recorded state" : "No records"}</div>}
      <div className="pipeline-chips">
        {displayedStates(row.lifecycle, states).map((state) => <Chip key={state.state} state={state} />)}
      </div>
      {unreachable.map((state) => (
        <div key={state.state} className="pipeline-callout">{calloutText(state, row.lifecycle as PipelineLifecycle)}</div>
      ))}
    </div>
  );
}

/** Right column: the tally sum and what its distance from the valid count means. */
function VerdictCell({ row }: { row: EntityTypeRow }): ReactNode {
  if (!row.lifecycle) {
    return (
      <div className="pipeline-verdict">
        <div className="pipeline-sum is-empty">—</div>
        <div className="pipeline-gap is-clean">No stages configured</div>
      </div>
    );
  }
  const verdict = rowVerdict(row);
  return (
    <div className="pipeline-verdict">
      <div className="pipeline-sum">{verdict.sum}</div>
      <div className={`pipeline-gap${verdict.rejected > 0 ? "" : " is-clean"}`}>{gapText(verdict)}</div>
    </div>
  );
}

function TypeRow({ row }: { row: EntityTypeRow }): ReactNode {
  const states = classifyStates(row.lifecycle, row.stateCounts);
  return (
    <div className="pipeline-columns pipeline-row" data-entity-type={row.type}>
      <TypeCell row={row} />
      <TallyCell row={row} states={states} />
      <VerdictCell row={row} />
    </div>
  );
}

/** The relation types the profile declares, with how many links each has recorded. */
function Connections({ relations }: { relations: RelationTypeRow[] }): ReactNode {
  return (
    <details className="pipeline-relations">
      <summary>How records connect</summary>
      <p className="pipeline-note">These are the connections this project supports. Counts show links currently recorded.</p>
      {relations.length === 0 ? <p className="pipeline-note">No connection types configured.</p> : (
        <table className="pipeline-table">
          <thead><tr><th scope="col">Relationship</th><th scope="col">Connects</th><th scope="col">Recorded links</th></tr></thead>
          <tbody>
            {relations.map((relation) => (
              <tr key={relation.type} title={relation.type}>
                <td>{displayLabel(relation.type)}</td>
                <td>{relation.from.map(displayLabel).join(" or ")}<span className="pipeline-arrow">{relation.direction === "symmetric" ? " ↔ " : " → "}</span>{relation.to.map(displayLabel).join(" or ")}</td>
                <td>{relation.count > 0 ? `${relation.count} recorded ${relation.count === 1 ? "link" : "links"}` : "No links yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/** The artifact types the profile declares: file name, content kind, and metadata fields. */
function ArtifactTypes({ types }: { types: ArtifactTypeDef[] }): ReactNode {
  if (types.length === 0) return null;
  return (
    <details className="pipeline-relations">
      <summary>Attached file types</summary>
      <table className="pipeline-table">
        <thead><tr><th scope="col">File type</th><th scope="col">File name</th><th scope="col">Content</th><th scope="col">Metadata fields</th></tr></thead>
        <tbody>
          {types.map((type) => (
            <tr key={type.type} title={type.type}>
              <td>{displayLabel(type.type)}</td>
              <td><code>{type.fileName}</code></td>
              <td>{type.contentKind}</td>
              <td>{(type.metadata ?? []).map((field) => field.name).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The validation problems the server reported, as far as the envelope carries them. */
function ProfileProblems({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const problems = wiki.profileProblems ?? [];
  if (problems.length === 0) return null;
  return (
    <section className="pipeline-problems" aria-label="Validation warnings">
      <h2>Validation warnings</h2>
      <ul>
        {problems.map((problem, index) => (
          <li key={index}>
            <code>{problem.kind}</code>
            {problem.entityType && <span className="chip">{problem.entityType}</span>}
            {problem.path && <span className="pipeline-path">{problem.path}</span>}
            <span>{problem.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The footer band, present only when there are rejected pages or problems to report. */
function Footer({ wiki, rejected }: { wiki: PagesEnvelope; rejected: number }): ReactNode {
  const problems = wiki.profileProblemTotal ?? 0;
  if (rejected + problems === 0) return null;
  return (
    <div className="pipeline-footer">
      <span>{footerText(rejected)}</span>
      <a href={LINT_HREF}>See all {plural(problems, "problem")} in Lint →</a>
    </div>
  );
}

/** The lifecycle status of every declared type; a default project gets the teaching card. */
export function PipelineView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const pipeline = wiki.profilePipeline;
  if (!pipeline || pipeline.entityTypes.length === 0) {
    return (
      <section className="list-screen">
        <h1>Lifecycle status</h1>
        <EmptyState title="No record stages configured" body="This project does not define categories with tracked stages. You can still browse its pages and source files." command="$ llmwiki template init" />
      </section>
    );
  }
  return (
    <section className="pipeline">
      <div className="pipeline-head">
        <h1>Lifecycle status</h1>
        <span className="pipeline-profile-badge">{wiki.profileId.toUpperCase()}</span>
      </div>
      <p className="pipeline-note">Current record counts, not completion percentages or workflow execution. Terminal means an ending state, not necessarily success. Records missing a state are not included in these counts; see Health &amp; lint for validation problems.</p>
      <div className="pipeline-columns pipeline-column-head">
        <span>{COLUMN_HEADS[0]}</span><span>{COLUMN_HEADS[1]}</span><span className="pipeline-col-right">{COLUMN_HEADS[2]}</span>
      </div>
      {pipeline.entityTypes.map((row) => <TypeRow key={row.type} row={row} />)}
      <Connections relations={pipeline.relationTypes ?? []} />
      <ArtifactTypes types={pipeline.artifactTypes ?? []} />
      <ProfileProblems wiki={wiki} />
      <Footer wiki={wiki} rejected={totalRejected(pipeline.entityTypes)} />
    </section>
  );
}
