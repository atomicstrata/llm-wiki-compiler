/**
 * Shows the original images kept by sources: the grid a source screen shows
 * for its own images, and the strip under a page for the images of every
 * source it cites, each linking back to its source.
 */
import type { ReactNode } from "react";
import { fetchSourceMeta, sourceImageUrl } from "./api";
import { sourceHref } from "./route";
import { useAsync } from "./use-async";

interface SourceImage {
  sourceId: string;
  file: string;
}

/** Collect the images every given source declares; a source that fails to load just contributes none. */
async function loadSourceImages(sourceIds: string[]): Promise<SourceImage[]> {
  const perSource = await Promise.all(sourceIds.map(async (sourceId) => {
    const meta = await fetchSourceMeta(sourceId).catch(() => ({ images: [] }));
    return (meta.images ?? []).map((file) => ({ sourceId, file }));
  }));
  return perSource.flat();
}

/** One image with a caption linking to the source it came from. */
function SourceImageFigure({ sourceId, file }: SourceImage): ReactNode {
  return (
    <figure className="min-w-0">
      <a href={sourceImageUrl(sourceId, file)} target="_blank" rel="noreferrer" className="block">
        <img src={sourceImageUrl(sourceId, file)} alt={`${file}, an original image from ${sourceId}`} loading="lazy"
          className="w-full rounded-lg bg-zinc-100 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10" />
      </a>
      <figcaption className="mt-1.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
        From <a href={sourceHref(sourceId)} className="font-mono text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">{sourceId}</a>
      </figcaption>
    </figure>
  );
}

/** A grid of source images, or nothing when there are none. */
export function ImageGrid({ images }: { images: SourceImage[] }): ReactNode {
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {images.map((image) => <SourceImageFigure key={`${image.sourceId}/${image.file}`} {...image} />)}
    </div>
  );
}

/**
 * The images of all cited sources. Most pages have none, so it stays quiet
 * while checking; a cited source that is missing is already reported by the
 * page's unresolved-citation warning, so it does not hide the others' images.
 */
export function SourceImages({ sourceIds }: { sourceIds: string[] }): ReactNode {
  const state = useAsync(() => loadSourceImages(sourceIds), sourceIds.join("\n"));
  if (state.status !== "ready" || state.data.length === 0) return null;
  return (
    <section aria-label="Images from cited sources">
      <h2 className="mb-3 text-sm font-semibold text-zinc-950 dark:text-white">Images</h2>
      <ImageGrid images={state.data} />
    </section>
  );
}
