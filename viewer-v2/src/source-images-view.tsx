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
    <figure className="min-w-0">
      <a href={sourceImageUrl(sourceId, file)} target="_blank" rel="noreferrer" className="block">
        <img src={sourceImageUrl(sourceId, file)} alt={`Original image from ${sourceId}`} loading="lazy"
          className="w-full rounded-lg bg-zinc-100 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10" />
      </a>
      <figcaption className="mt-1.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
        From <a href={sourceHref(sourceId)} className="font-mono text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">{sourceId}</a>
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
          <h2 className="mb-3 text-sm font-semibold text-zinc-950 dark:text-white">Images</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {images.map((image) => <SourceImageFigure key={`${image.sourceId}/${image.file}`} {...image} />)}
          </div>
        </section>
      )}
    </AsyncView>
  );
}
