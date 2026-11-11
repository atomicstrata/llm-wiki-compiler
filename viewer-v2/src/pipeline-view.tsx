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
import { Badge, Card, Code, EmptyState, Notice, Screen, Table, Td, TextLink, type Tone } from "./components";
import { problemsSummary } from "./health-model";
import { ProblemsPanel } from "./health-view";
import {
  calloutText, chipLabel, classifyStates, declaredText, displayLabel, displayedStates, footerText, gapText,
  hasDeclaredOrder, reachableOrder, rowVerdict, totalRejected, type StateRole, type StateTally,
} from "./pipeline-model";
import { plural, typeLabel } from "./wiki-model";

const HEALTH_HREF = "#/health";
const SCREEN_TITLE = "Lifecycle status";

/** A chip's colour follows its role; the role is also spelled out in the label. */
const ROLE_TONE: Record<StateRole, Tone> = { terminal: "green", unreachable: "amber", flight: "indigo", empty: "neutral" };

/** Left column: the type's name and valid page count, then what it declares. */
function TypeCell({ row }: { row: EntityTypeRow }): ReactNode {
  const chain = reachableOrder(row.lifecycle);
  return (
    <div className="min-w-0 space-y-1 lg:col-span-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-950 dark:text-white">{typeLabel(row.type)}</span>
        <Badge>{row.pageCount}</Badge>
      </div>
      <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{row.directory}</div>
      {hasDeclaredOrder(row.lifecycle) && chain.length > 1 && <div className="text-sm text-zinc-700 dark:text-zinc-300">{chain.join(" → ")}</div>}
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{declaredText(row.lifecycle)}</div>
    </div>
  );
}

/** Middle column: every state with its count, and a callout per unreachable state. */
function TallyCell({ row, states }: { row: EntityTypeRow; states: StateTally[] }): ReactNode {
  const unreachable = states.filter((entry) => entry.role === "unreachable");
  return (
    <div className="min-w-0 space-y-2 lg:col-span-6">
      {states.length === 0 && <div className="text-sm text-zinc-500 dark:text-zinc-400">{row.pageCount > 0 ? "No records have a recorded state" : "No records"}</div>}
      <div className="flex flex-wrap gap-1.5">
        {displayedStates(row.lifecycle, states).map((state) => <Badge key={state.state} tone={ROLE_TONE[state.role]}>{chipLabel(state)}</Badge>)}
      </div>
      {unreachable.map((state) => <Notice key={state.state}>{calloutText(state, row.lifecycle as PipelineLifecycle)}</Notice>)}
    </div>
  );
}

/** Right column: the tally sum and what its distance from the valid count means. */
function VerdictCell({ row }: { row: EntityTypeRow }): ReactNode {
  const verdict = row.lifecycle ? rowVerdict(row) : null;
  return (
    <div className="lg:col-span-2 lg:text-right">
      <div className="text-2xl font-semibold tracking-tight text-zinc-950 tabular-nums dark:text-white">{verdict ? verdict.sum : "—"}</div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{verdict ? gapText(verdict) : "No stages configured"}</div>
    </div>
  );
}

function TypeRow({ row }: { row: EntityTypeRow }): ReactNode {
  const states = classifyStates(row.lifecycle, row.stateCounts);
  return (
    <Card>
      <div className="grid gap-4 lg:grid-cols-12">
        <TypeCell row={row} />
        <TallyCell row={row} states={states} />
        <VerdictCell row={row} />
      </div>
    </Card>
  );
}

/** A collapsible card holding one of the declared-type tables. */
function DetailsCard({ summary, children }: { summary: string; children: ReactNode }): ReactNode {
  return (
    <Card flush>
      <details>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-zinc-50 dark:text-white dark:hover:bg-white/5">{summary}</summary>
        <div className="border-t border-zinc-950/5 dark:border-white/10">{children}</div>
      </details>
    </Card>
  );
}

/** The relation types the profile declares, with how many links each has recorded. */
function Connections({ relations }: { relations: RelationTypeRow[] }): ReactNode {
  return (
    <DetailsCard summary="How records connect">
      <p className="px-4 pt-3 pb-2 text-sm text-zinc-500 dark:text-zinc-400">These are the connections this project supports. Counts show links currently recorded.</p>
      {relations.length === 0 ? <p className="px-4 pb-4 text-sm text-zinc-500 dark:text-zinc-400">No connection types configured.</p> : (
        <Table head={["Relationship", "Connects", "Recorded links"]}>
          {relations.map((relation) => (
            <tr key={relation.type} title={relation.type}>
              <Td>{displayLabel(relation.type)}</Td>
              <Td>{relation.from.map(displayLabel).join(" or ")}<span className="text-zinc-400">{relation.direction === "symmetric" ? " ↔ " : " → "}</span>{relation.to.map(displayLabel).join(" or ")}</Td>
              <Td>{relation.count > 0 ? plural(relation.count, "recorded link") : "No links yet"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </DetailsCard>
  );
}

/** The artifact types the profile declares: file name, content kind, and metadata fields. */
function ArtifactTypes({ types }: { types: ArtifactTypeDef[] }): ReactNode {
  if (types.length === 0) return null;
  return (
    <DetailsCard summary="Attached file types">
      <Table head={["File type", "File name", "Content", "Metadata fields"]}>
        {types.map((type) => (
          <tr key={type.type} title={type.type}>
            <Td>{displayLabel(type.type)}</Td>
            <Td><Code>{type.fileName}</Code></Td>
            <Td>{type.contentKind}</Td>
            <Td>{(type.metadata ?? []).map((field) => field.name).join(", ") || "—"}</Td>
          </tr>
        ))}
      </Table>
    </DetailsCard>
  );
}

/** The footer band, present only when there are rejected pages or problems to report; it links to problems only when there are some. */
function Footer({ wiki, rejected }: { wiki: PagesEnvelope; rejected: number }): ReactNode {
  const { total } = problemsSummary(wiki);
  if (rejected + total === 0) return null;
  return (
    <Notice>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{footerText(rejected)}</span>
        {total > 0 && <TextLink href={HEALTH_HREF}>See all {plural(total, "problem")} in Health →</TextLink>}
      </div>
    </Notice>
  );
}

/** The lifecycle status of every declared type; a default project gets the teaching card. */
export function PipelineView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const pipeline = wiki.profilePipeline;
  if (!pipeline || pipeline.entityTypes.length === 0) {
    return (
      <Screen title={SCREEN_TITLE}>
        <EmptyState title="No record stages configured" body="This project does not define categories with tracked stages. You can still browse its pages and source files." command="$ llmwiki template init" />
      </Screen>
    );
  }
  return (
    <Screen wide title={SCREEN_TITLE} actions={<Badge tone="indigo">{wiki.profileId.toUpperCase()}</Badge>}
      description="Current record counts, not completion percentages or workflow execution. Terminal means an ending state, not necessarily success. Records missing a state are not included in these counts; see Health & lint for validation problems.">
      <div className="space-y-4">
        {/* A visual guide to the three columns of each card below; the cards carry their own labels. */}
        <div aria-hidden="true" className="hidden px-4 text-xs font-medium text-zinc-500 lg:grid lg:grid-cols-12 lg:gap-4 dark:text-zinc-400">
          <span className="lg:col-span-4">Category · declared lifecycle</span>
          <span className="lg:col-span-6">Records by current state</span>
          <span className="lg:col-span-2 lg:text-right">State check</span>
        </div>
        {pipeline.entityTypes.map((row) => <TypeRow key={row.type} row={row} />)}
        <Connections relations={pipeline.relationTypes ?? []} />
        <ArtifactTypes types={pipeline.artifactTypes ?? []} />
        <ProblemsPanel wiki={wiki} />
        <Footer wiki={wiki} rejected={totalRejected(pipeline.entityTypes)} />
      </div>
    </Screen>
  );
}
