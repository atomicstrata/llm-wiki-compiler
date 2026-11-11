/**
 * Shows the original images kept by a set of sources.
 *
 * A page cites sources, and a source may declare images. This asks the server
 * for each cited source's metadata and shows the images it lists, each with a
 * link back to its source.
 */
import type { ReactNode } from "react";
import { fetchSourceMeta, sourceImageUrl } from "./api";
import { AsyncView } from "./async-view";
import { sourceHref } from "./route";
import { useAsync } from "./use-async";

interface SourceImage {
  sourceId: string;
  file: string;
}

/** Collect the images every given source declares. */
async function loadSourceImages(sourceIds: string[]): Promise<SourceImage[]> {
  const perSource = await Promise.all(sourceIds.map(async (sourceId) => {
    const meta = await fetchSourceMeta(sourceId);
    return (meta.images ?? []).map((file) => ({ sourceId, file }));
  }));
  return perSource.flat();
}

/** One image with a caption linking to the source it came from. */
export function SourceImageFigure({ sourceId, file }: SourceImage): ReactNode {
  return (
    <figure>
      <a href={sourceImageUrl(sourceId, file)} target="_blank" rel="noreferrer">
        <img src={sourceImageUrl(sourceId, file)} alt={`Original image from ${sourceId}`} loading="lazy" />
      </a>
      <figcaption>
        From <a href={sourceHref(sourceId)}>{sourceId}</a>
      </figcaption>
    </figure>
  );
}

/** The images of all cited sources, or nothing when they declare none. */
export function SourceImages({ sourceIds }: { sourceIds: string[] }): ReactNode {
  const state = useAsync(() => loadSourceImages(sourceIds), sourceIds.join("\n"));
  // Most pages have no images, so stay quiet while checking; a failure is still shown.
  if (state.status === "loading") return null;
  return (
    <AsyncView state={state}>
      {(images) => images.length > 0 && (
        <section aria-label="Images from cited sources">
          <h2>Images</h2>
          {images.map((image) => <SourceImageFigure key={`${image.sourceId}/${image.file}`} {...image} />)}
        </section>
      )}
    </AsyncView>
  );
}
