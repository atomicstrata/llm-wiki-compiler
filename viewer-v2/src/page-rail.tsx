/**
 * The support rail beside a page: metadata, every citation grouped by source
 * file, the page's outgoing links and backlinks, and a typed page's entity
 * context. The page payload carries no backlinks, so they come from the graph,
 * which the page view loads once and hands down as it settles.
 */
import type { ReactNode } from "react";
import type { ConnectorProvenance, EntityContext, EntityRelation, GraphData, PagePayload, PagesEnvelope, SourceSpan } from "./api";
import { AsyncView } from "./async-view";
import { backlinksFrom, connectorHref, groupCitationsByFile, groupRelations, pageCitationCounts, pageKind, spanLabel } from "./page-model";
import { pageIdHref, sourceHref } from "./route";
import type { AsyncState } from "./use-async";
import { formatUtcTimestamp, isWarnFreshness, typeLabel } from "./wiki-model";

/** A rail section with the small uppercase heading. */
function RailSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="rail-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** The freshness status with the same dot the list rows use, plus the provenance flags. */
function FreshnessValue({ page }: { page: PagePayload }): ReactNode {
  const { freshnessStatus, contradicted, archived } = page.freshness;
  const flags = [freshnessStatus, contradicted ? "contradicted" : "", archived ? "archived" : ""].filter((flag) => flag.length > 0);
  return (
    <>
      <span className={`dot ${isWarnFreshness(freshnessStatus) ? "is-warn" : "is-ok"}`} title={freshnessStatus} aria-label={freshnessStatus} />
      {flags.join(" · ")}
    </>
  );
}

function MetadataSection({ page }: { page: PagePayload }): ReactNode {
  const counts = pageCitationCounts(page);
  const rows: [string, ReactNode][] = [
    ["Kind", pageKind(page)],
    ["Freshness", <FreshnessValue page={page} />],
    ["Created", formatUtcTimestamp(page.createdAt)],
    ["Updated", formatUtcTimestamp(page.updatedAt)],
    ["Citations", counts.total],
    ["Unresolved", <span className={counts.unresolved > 0 ? "is-warn" : undefined}>{counts.unresolved}</span>],
  ];
  return (
    <RailSection title="Metadata">
      <dl className="receipt">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </RailSection>
  );
}

/** A cited span: a link to the source at its lines when the file exists, otherwise a marked label. */
function SpanLink({ span, resolved }: { span: SourceSpan; resolved: boolean }): ReactNode {
  const label = spanLabel(span);
  if (!resolved) return <span className="rail-file is-unresolved" data-resolved="false">{label} <span className="rail-note">not found</span></span>;
  return <a className="rail-file" data-resolved="true" href={sourceHref(span.file, span.lines?.start, span.lines?.end)}>{label}</a>;
}

function CitationsSection({ page, wiki }: { page: PagePayload; wiki: PagesEnvelope }): ReactNode {
  const groups = groupCitationsByFile(page.citations, wiki.sourceFilenames);
  return (
    <RailSection title="Citations">
      {groups.length === 0 ? <p className="rail-empty">No citations.</p> : (
        <ul>
          {groups.map((group) => (
            <li key={group.file} data-file={group.file}>
              <ul className="span-list">
                {group.spans.map((span) => <li key={spanLabel(span)}><SpanLink span={span} resolved={group.resolved} /></li>)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

/** Page ids as links titled from the envelope, or an empty note. */
function PageLinks({ ids, wiki, whenEmpty }: { ids: string[]; wiki: PagesEnvelope; whenEmpty: string }): ReactNode {
  if (ids.length === 0) return <p className="rail-empty">{whenEmpty}</p>;
  return (
    <ul>
      {ids.map((id) => <li key={id}><a href={pageIdHref(id)}>{wiki.pages.find((page) => page.id === id)?.title || id}</a></li>)}
    </ul>
  );
}

function ConnectionsSection({ page, wiki, graph }: { page: PagePayload; wiki: PagesEnvelope; graph: AsyncState<GraphData> }): ReactNode {
  return (
    <RailSection title="Connections">
      <h3>Links out</h3>
      <PageLinks ids={page.outgoingLinks} wiki={wiki} whenEmpty="No outgoing links." />
      <h3>Backlinks</h3>
      <AsyncView state={graph}>
        {(data) => {
          const links = backlinksFrom(data, page.id);
          if (links.length === 0) return <p className="rail-empty">No backlinks.</p>;
          return <ul>{links.map((link) => <li key={link.id}><a href={link.href}>{link.title}</a></li>)}</ul>;
        }}
      </AsyncView>
    </RailSection>
  );
}

/** One related record; an unresolved target keeps its id and says so. */
function RelationItem({ relation }: { relation: EntityRelation }): ReactNode {
  const { target } = relation;
  return (
    <li title={`${relation.type} · ${relation.direction} · ${target.id}`}>
      {target.resolved
        ? <a href={pageIdHref(target.id)}>{target.title || target.id}</a>
        : <>{target.id} <span className="rail-note">not found</span></>}
    </li>
  );
}

/** The import a typed page's details came from, with the exact identifiers kept out of the reading line. */
function ConnectorBlock({ connector }: { connector: ConnectorProvenance }): ReactNode {
  const href = connectorHref(connector.sourceUrl);
  return (
    <div className="rail-connector" data-connector={connector.connectorId}>
      <h3>Where these details came from</h3>
      <p>Imported from {typeLabel(connector.connectorId)} on {formatUtcTimestamp(connector.fetchedAt)}.</p>
      {href && <a href={href} target="_blank" rel="noopener noreferrer">View imported metadata</a>}
      <details>
        <summary>Technical details</summary>
        <pre>{`Importer: ${connector.connectorId}\nVersion: ${connector.connectorVersion}\nContent hash: ${connector.contentHash}`}</pre>
      </details>
    </div>
  );
}

/** A typed page's relations by type and direction, its evidence spans, and its import provenance. */
function EntityContextSection({ context }: { context: EntityContext }): ReactNode {
  const groups = groupRelations(context.relations);
  return (
    <RailSection title="Connected records">
      {groups.length === 0 && <p className="rail-empty">No connections recorded yet.</p>}
      {groups.map((group) => (
        <div key={`${group.type}:${group.direction}`}>
          <h3>{typeLabel(group.type)} <span className="rail-note">{group.direction}</span></h3>
          <ul>{group.relations.map((relation) => <RelationItem key={relation.target.id} relation={relation} />)}</ul>
        </div>
      ))}
      {context.relationTotal > context.relations.length && <p className="rail-note">Showing {context.relations.length} of {context.relationTotal} relations.</p>}
      <h3>Supporting evidence</h3>
      {context.sources.length === 0 && <p className="rail-empty">No supporting source passages linked yet.</p>}
      <ul>{context.sources.map((source) => <li key={spanLabel(source)}><SpanLink span={source} resolved={source.resolved} /></li>)}</ul>
      {context.sourceTotal > context.sources.length && <p className="rail-note">Showing {context.sources.length} of {context.sourceTotal} source spans.</p>}
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
    <aside className="rail" aria-label="Page details">
      <MetadataSection page={page} />
      <CitationsSection page={page} wiki={wiki} />
      <ConnectionsSection page={page} wiki={wiki} graph={graph} />
      {page.entityContext && <EntityContextSection context={page.entityContext} />}
    </aside>
  );
}
