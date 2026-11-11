/**
 * "Cited by" on a source: every wiki page that cites the file, with the line
 * ranges each one cites. A range opens this source at those lines, so the
 * reader can check a claim against its evidence and see what else rests on
 * the same passage. The server answers from its in-memory snapshot, so this
 * works even where the source text itself is loopback-only.
 */
import type { ReactNode } from "react";
import { getJson } from "./api";
import { AsyncView } from "./async-view";
import { Card, RangeChip, RowList } from "./components";
import { rangeLabel } from "./page-model";
import { pageIdHref, sourceHref } from "./route";
import { useAsync } from "./use-async";
import { plural } from "./wiki-model";

/** One cited range; null when the citation names the whole file. */
type CitedLines = { start: number; end: number } | null;

/** One page citing the source; its id is also its route. */
interface CitingPage {
  id: string;
  title: string;
  spans: CitedLines[];
}

/** The `/cited-by` payload. */
interface CitedByPayload {
  source: string;
  pages: CitingPage[];
}

/** The pages citing a source. */
function fetchCitedBy(id: string): Promise<CitedByPayload> {
  return getJson(`/api/source/${encodeURIComponent(id)}/cited-by`);
}

/** One citing page and its ranges. */
function CitingRow({ source, page }: { source: string; page: CitingPage }): ReactNode {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
      <a href={pageIdHref(page.id)} data-page-id={page.id}
        className="min-w-0 flex-1 font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">{page.title}</a>
      <span className="flex flex-wrap gap-1">
        {page.spans.map((span) => (
          <RangeChip key={rangeLabel(span)} href={sourceHref(source, span?.start, span?.end)} label={rangeLabel(span)} />
        ))}
      </span>
    </li>
  );
}

/** The list for a loaded payload. */
export function CitedByList({ payload }: { payload: CitedByPayload }): ReactNode {
  if (payload.pages.length === 0) return <p className="p-4 text-sm text-zinc-500">No page cites this source yet.</p>;
  return <RowList>{payload.pages.map((page) => <CitingRow key={page.id} source={payload.source} page={page} />)}</RowList>;
}

/** The card on the source screen. */
export function CitedByCard({ id }: { id: string }): ReactNode {
  const state = useAsync(() => fetchCitedBy(id), id);
  const title = state.status === "ready" ? `Cited by ${plural(state.data.pages.length, "page")}` : "Cited by";
  return (
    <Card flush title={title}>
      <AsyncView state={state}>{(payload) => <CitedByList payload={payload} />}</AsyncView>
    </Card>
  );
}
