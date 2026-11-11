/**
 * One ingested source: the pages that cite it, the images it declares, and its
 * full text with line numbers, so a citation such as `notes.md:12-15` can be
 * checked against the exact lines.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { fetchSourceMeta, fetchSourceText, type SourceMeta } from "./api";
import { AsyncView } from "./async-view";
import { CitedByCard } from "./cited-by";
import { Card, Screen, TextLink } from "./components";
import { ImageGrid } from "./source-images-view";
import { useAsync } from "./use-async";

interface SourceViewProps {
  id: string;
  lineStart?: number;
  lineEnd?: number;
}

interface LoadedSource {
  meta: SourceMeta;
  text: string;
}

/** Load a source's metadata and text together. */
async function loadSource(id: string): Promise<LoadedSource> {
  const [meta, text] = await Promise.all([fetchSourceMeta(id), fetchSourceText(id)]);
  return { meta, text };
}

/** The source text as numbered lines, with the cited range marked and scrolled into view. */
function SourceLines({ text, lineStart, lineEnd }: { text: string; lineStart?: number; lineEnd?: number }): ReactNode {
  const firstCited = useRef<HTMLLIElement>(null);
  useEffect(() => {
    firstCited.current?.scrollIntoView({ block: "center" });
  }, [text, lineStart]);
  const isCited = (line: number): boolean =>
    lineStart !== undefined && line >= lineStart && line <= (lineEnd ?? lineStart);
  return (
    <Card flush>
      <ol className="list-decimal overflow-x-auto py-3 pr-4 pl-14 font-mono text-xs leading-5 text-zinc-800 marker:text-zinc-400 dark:text-zinc-200 dark:marker:text-zinc-500">
        {text.split(/\r?\n/).map((line, index) => {
          const number = index + 1;
          return (
            <li key={number} ref={number === lineStart ? firstCited : undefined}
              className={`min-h-5 pl-2 break-words whitespace-pre-wrap ${isCited(number) ? "bg-amber-50 dark:bg-amber-500/10" : ""}`}>
              {line}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** A link to where the source came from, or nothing when it has no locator. */
function OriginalLink({ locator }: { locator?: string }): ReactNode {
  return locator ? <TextLink href={locator} target="_blank" rel="noreferrer">Original</TextLink> : null;
}

/** A loaded source: its id and original link in the header, then its images and numbered text. */
function SourceDocument({ id, source, lineStart, lineEnd }: { id: string; source: LoadedSource; lineStart?: number; lineEnd?: number }): ReactNode {
  const { meta, text } = source;
  return (
    <Screen title={meta.title ?? id} description={<span className="font-mono text-xs break-all">{id}</span>} actions={<OriginalLink locator={meta.locator} />}>
      <div className="space-y-6">
        <CitedByCard id={id} />
        <ImageGrid images={(meta.images ?? []).map((file) => ({ sourceId: id, file }))} />
        <SourceLines text={text} lineStart={lineStart} lineEnd={lineEnd} />
      </div>
    </Screen>
  );
}

/** Load and show the source `id`, highlighting an optional cited line range. */
export function SourceView({ id, lineStart, lineEnd }: SourceViewProps): ReactNode {
  const state = useAsync(() => loadSource(id), id);
  return (
    <AsyncView state={state}>
      {(source) => <SourceDocument id={id} source={source} lineStart={lineStart} lineEnd={lineEnd} />}
    </AsyncView>
  );
}
