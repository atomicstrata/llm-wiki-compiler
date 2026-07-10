/**
 * Safe-filename grammar for artifact leaf files. Distinct from slug-safe
 * (`isSlugSafe` rejects the `.`), this admits exactly one extension drawn from a
 * per-contentKind allowlist. Reuses the hardened `isSafeFilenameComponent` base
 * guard (no separators, no NUL, no dotfile, no `.`/`..`) and layers the extension
 * allowlist on top so a declared fileName can never traverse or shadow a store file.
 */
import { isSafeFilenameComponent } from "../profile/identity.js";

/** Allowed extensions per contentKind. */
const EXTENSIONS: Record<"json" | "text", readonly string[]> = {
  json: [".json"],
  text: [".txt", ".md"],
};

/** True when `fileName` is a safe component AND its single extension fits `contentKind`. */
export function isValidArtifactFileName(fileName: string, contentKind: "json" | "text"): boolean {
  if (!isSafeFilenameComponent(fileName)) return false;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return false; // needs a non-empty stem + ext
  const stem = fileName.slice(0, dot);
  if (!/^[a-z0-9_-]+$/.test(stem)) return false;
  return EXTENSIONS[contentKind].includes(fileName.slice(dot).toLowerCase());
}

/** Surface hard cap for a single artifact's declared maxBytes (v0). */
export const MAX_ARTIFACT_BYTES = 1024 * 1024; // 1 MiB
