/**
 * Plain concept names shared by fresh extraction and cached extraction admission.
 * Wikilink targets and labels must not be concatenated into a second page ID.
 */

/** Render model-returned wikilinks as display text before deriving identity. */
export function plainConceptTitle(title: string): string {
  return title.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]|]*))?\]\]/g,
    (_link, target: string, display: string | undefined) => display?.trim() || target.trim());
}
