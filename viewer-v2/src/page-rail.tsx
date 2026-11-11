/**
 * The support rail beside a page: metadata, every citation grouped by source
 * file, the page's outgoing links and backlinks, and a typed page's entity
 * context. The page payload carries no backlinks, so they come from the graph,
 * which the page view loads once and hands down as it settles.
 */
import type { ReactNode } from "react";
import type { ConnectorProvenance, EntityContext, EntityRelation, GraphData, PagePayload, PagesEnvelope, SourceSpan } from "./api";
import { AsyncView } from "./async-view";
import { Badge, DefinitionRows, RangeChip, SURFACE } from "./components";
import { backlinksFrom, connectorHref, groupCitationsByFile, groupRelations, pageCitationCounts, pageKind, rangeLabel, spanLabel } from "./page-model";
import { pageIdHref, sourceHref } from "./route";
import type { AsyncState } from "./use-async";
import { formatUtcTimestamp, typeLabel } from "./wiki-model";

/** A rail section with the small uppercase heading. */
export function RailSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className={`p-4 text-sm ${SURFACE}`}>
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{title}</h2>
      {children}
    </section>
  );
}

/** The freshness status followed by the provenance flags that apply, such as `stale · contradicted`. */
function freshnessText({ freshnessStatus, contradicted, archived }: PagePayload["freshness"]): string {
  return [freshnessStatus, contradicted && "contradicted", archived && "archived"].filter(Boolean).join(" · ");
}

function MetadataSection({ page }: { page: PagePayload }): ReactNode {
  const counts = pageCitationCounts(page);
  const rows: [string, ReactNode][] = [
    ["Kind", pageKind(page)],
    ["Freshness", freshnessText(page.freshness)],
    ["Created", formatUtcTimestamp(page.createdAt)],
    ["Updated", formatUtcTimestamp(page.updatedAt)],
    ["Citations", counts.total],
    ["Unresolved", <span className={counts.unresolved > 0 ? "text-amber-600 dark:text-amber-400" : ""}>{counts.unresolved}</span>],
  ];
  return (
    <RailSection title="Metadata">
      <DefinitionRows rows={rows} />
    </RailSection>
  );
}

/** A cited span: a link to the source at its lines when the file exists, otherwise a marked label. */
function SpanLink({ span, resolved }: { span: SourceSpan; resolved: boolean }): ReactNode {
  const label = spanLabel(span);
  if (!resolved) return <span data-resolved="false" className="font-mono text-xs break-all text-zinc-400">{label} <Badge tone="amber">not found</Badge></span>;
  return <a data-resolved="true" href={sourceHref(span.file, span.lines?.start, span.lines?.end)} className="font-mono text-xs break-all text-indigo-600 hover:underline dark:text-indigo-400">{label}</a>;
}

/** A cited range as a small chip under its file: a link when the file exists, struck through when it does not. */
function LineChip({ span, resolved }: { span: SourceSpan; resolved: boolean }): ReactNode {
  const label = rangeLabel(span.lines);
  if (!resolved) return <span data-resolved="false" className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">{label} · not found</span>;
  return <RangeChip href={sourceHref(span.file, span.lines?.start, span.lines?.end)} label={label} title={spanLabel(span)} />;
}

function CitationsSection({ page, wiki }: { page: PagePayload; wiki: PagesEnvelope }): ReactNode {
  const groups = groupCitationsByFile(page.citations, wiki.sourceFilenames);
  return (
    <RailSection title="Citations">
      {groups.length === 0 ? <p className="text-zinc-500">No citations.</p> : (
        <ul role="list" className="space-y-3">
          {groups.map((group) => (
            <li key={group.file} data-file={group.file}>
              <p className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={group.file}>{group.file}</p>
              <ul role="list" className="mt-1 flex flex-wrap gap-1">
                {group.spans.map((span) => <li key={spanLabel(span)}><LineChip span={span} resolved={group.resolved} /></li>)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

/** Pages as links that preview on hover, or a note when there are none. */
function LinkList({ links, whenEmpty }: { links: { id: string; title: string }[]; whenEmpty: string }): ReactNode {
  if (links.length === 0) return <p className="text-zinc-500">{whenEmpty}</p>;
  return (
    <ul role="list" className="space-y-1">
      {links.map((link) => <li key={link.id}><a href={pageIdHref(link.id)} data-page-id={link.id} className={RAIL_LINK}>{link.title}</a></li>)}
    </ul>
  );
}

function ConnectionsSection({ page, wiki, graph }: { page: PagePayload; wiki: PagesEnvelope; graph: AsyncState<GraphData> }): ReactNode {
  const titles = new Map(wiki.pages.map((row) => [row.id, row.title]));
  const linksOut = page.outgoingLinks.map((id) => ({ id, title: titles.get(id) || id }));
  return (
    <RailSection title="Connections">
      <h3 className={RAIL_HEADING}>Links out</h3>
      <LinkList links={linksOut} whenEmpty="No outgoing links." />
      <h3 className={RAIL_HEADING}>Backlinks</h3>
      <AsyncView state={graph}>{(data) => <LinkList links={backlinksFrom(data, page.id)} whenEmpty="No backlinks." />}</AsyncView>
    </RailSection>
  );
}

const RAIL_HEADING = "mt-4 mb-1 flex items-center gap-2 font-medium text-zinc-900 first:mt-0 dark:text-zinc-100";
const RAIL_NOTE = "text-xs text-zinc-500 dark:text-zinc-400";
const RAIL_LINK = "text-zinc-700 hover:text-indigo-600 dark:text-zinc-300 dark:hover:text-indigo-400";

/** One related record; an unresolved target keeps its id and says so. */
function RelationItem({ relation }: { relation: EntityRelation }): ReactNode {
  const { target } = relation;
  return (
    <li title={`${relation.type} · ${relation.direction} · ${target.id}`}>
      {target.resolved
        ? <a href={pageIdHref(target.id)} data-page-id={target.id} className={RAIL_LINK}>{target.title || target.id}</a>
        : <span className="text-zinc-500">{target.id} <Badge tone="amber">not found</Badge></span>}
    </li>
  );
}

/** The import a typed page's details came from, with the exact identifiers kept out of the reading line. */
function ConnectorBlock({ connector }: { connector: ConnectorProvenance }): ReactNode {
  const href = connectorHref(connector.sourceUrl);
  return (
    <div data-connector={connector.connectorId} className="mt-4 border-t border-zinc-950/5 pt-3 dark:border-white/10">
      <h3 className={RAIL_HEADING}>Where these details came from</h3>
      <p className="text-zinc-600 dark:text-zinc-300">Imported from {typeLabel(connector.connectorId)} on {formatUtcTimestamp(connector.fetchedAt)}.</p>
      {href && <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">View imported metadata</a>}
      <details className={`mt-2 ${RAIL_NOTE}`}>
        <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-200">Technical details</summary>
        <pre className="mt-1 font-mono whitespace-pre-wrap">{`Importer: ${connector.connectorId}\nVersion: ${connector.connectorVersion}\nContent hash: ${connector.contentHash}`}</pre>
      </details>
    </div>
  );
}

/** A typed page's relations by type and direction. */
function RelationGroups({ context }: { context: EntityContext }): ReactNode {
  const groups = groupRelations(context.relations);
  if (groups.length === 0) return <p className={RAIL_NOTE}>No connections recorded yet.</p>;
  return (
    <>
      {groups.map((group) => (
        <div key={`${group.type}:${group.direction}`}>
          <h3 className={RAIL_HEADING}>{typeLabel(group.type)} <Badge>{group.direction}</Badge></h3>
          <ul role="list" className="space-y-1">{group.relations.map((relation) => <RelationItem key={relation.target.id} relation={relation} />)}</ul>
        </div>
      ))}
      {context.relationTotal > context.relations.length && <p className={`mt-2 ${RAIL_NOTE}`}>Showing {context.relations.length} of {context.relationTotal} relations.</p>}
    </>
  );
}

/** A typed page's relations, its evidence spans, and its import provenance. */
function EntityContextSection({ context }: { context: EntityContext }): ReactNode {
  return (
    <RailSection title="Connected records">
      <RelationGroups context={context} />
      <h3 className={RAIL_HEADING}>Supporting evidence</h3>
      {context.sources.length === 0 && <p className={RAIL_NOTE}>No supporting source passages linked yet.</p>}
      <ul role="list" className="flex flex-wrap gap-1">{context.sources.map((source) => <li key={spanLabel(source)}><SpanLink span={source} resolved={source.resolved} /></li>)}</ul>
      {context.sourceTotal > context.sources.length && <p className={`mt-2 ${RAIL_NOTE}`}>Showing {context.sources.length} of {context.sourceTotal} source spans.</p>}
      {context.connector && <ConnectorBlock connector={context.connector} />}
    </RailSection>
  );
}

interface PageRailProps {
  page: PagePayload;
  wiki: PagesEnvelope;
  graph: AsyncState<GraphData>;
}

/** The rail: metadata, citations, connections, and the entity context of a typed page. */
export function PageRail({ page, wiki, graph }: PageRailProps): ReactNode {
  return (
    <>
      <MetadataSection page={page} />
      <CitationsSection page={page} wiki={wiki} />
      <ConnectionsSection page={page} wiki={wiki} graph={graph} />
      {page.entityContext && <EntityContextSection context={page.entityContext} />}
    </>
  );
}
