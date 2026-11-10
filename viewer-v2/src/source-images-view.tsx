/**
 * Shows the original images kept by a set of sources.
 *
 * A page cites sources, and a source may keep images. This loads each cited
 * source's text, finds its images, and shows them with a link back to the
 * source. A source whose text cannot be read contributes no images.
 */
import type { ReactNode } from "react";
import { fetchSourceText, sourceImageUrl } from "./api";
import { sourceHref } from "./route";
import { sourceImageNames } from "./source-images";
import { useAsync } from "./use-async";

/** Upper bound on sources read for one page, so a heavily cited page stays cheap. */
const MAX_SOURCES_SCANNED = 12;

interface SourceImage {
  sourceId: string;
  file: string;
}

/** Collect the images of every given source. */
async function loadSourceImages(sourceIds: string[]): Promise<SourceImage[]> {
  const perSource = await Promise.all(sourceIds.slice(0, MAX_SOURCES_SCANNED).map(async (sourceId) => {
    const text = await fetchSourceText(sourceId).catch(() => "");
    return sourceImageNames(text).map((file) => ({ sourceId, file }));
  }));
  return perSource.flat();
}

/** One image with a caption linking to the source it came from. */
export function SourceImageFigure({ sourceId, file }: SourceImage): ReactNode {
  return (
    <figure className="source-image">
      <a href={sourceImageUrl(file)} target="_blank" rel="noreferrer">
        <img src={sourceImageUrl(file)} alt={`Original image from ${sourceId}`} loading="lazy" />
      </a>
      <figcaption>
        From <a href={sourceHref(sourceId)}>{sourceId}</a>
      </figcaption>
    </figure>
  );
}

/** The images of all cited sources, or nothing when there are none. */
export function SourceImages({ sourceIds }: { sourceIds: string[] }): ReactNode {
  const state = useAsync(() => loadSourceImages(sourceIds), sourceIds.join("\n"));
  if (state.status !== "ready" || state.data.length === 0) return null;
  return (
    <section className="source-images" aria-label="Images from cited sources">
      <h2>Images</h2>
      {state.data.map((image) => <SourceImageFigure key={`${image.sourceId}/${image.file}`} {...image} />)}
    </section>
  );
}
