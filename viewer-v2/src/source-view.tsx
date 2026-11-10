/**
 * One ingested source: its images and its full text with line numbers, so a
 * citation such as `notes.md:12-15` can be checked against the exact lines.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { fetchSourceMeta, fetchSourceText, type SourceMeta } from "./api";
import { AsyncView } from "./async-view";
import { SourceImageFigure } from "./source-images-view";
import { sourceImageNames } from "./source-images";
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
    <ol className="source-lines">
      {text.split(/\r?\n/).map((line, index) => {
        const number = index + 1;
        return (
          <li key={number} ref={number === lineStart ? firstCited : undefined} className={isCited(number) ? "cited" : undefined}>
            {line}
          </li>
        );
      })}
    </ol>
  );
}

/** Load and show the source `id`, highlighting an optional cited line range. */
export function SourceView({ id, lineStart, lineEnd }: SourceViewProps): ReactNode {
  const state = useAsync(() => loadSource(id), id);
  return (
    <AsyncView state={state}>
      {({ meta, text }) => (
        <article>
          <h1>{meta.title ?? id}</h1>
          <p className="page-meta">
            <span>{id}</span>
            {meta.locator && <a href={meta.locator} target="_blank" rel="noreferrer">Original</a>}
          </p>
          {sourceImageNames(text).map((file) => <SourceImageFigure key={file} sourceId={id} file={file} />)}
          <SourceLines text={text} lineStart={lineStart} lineEnd={lineEnd} />
        </article>
      )}
    </AsyncView>
  );
}
