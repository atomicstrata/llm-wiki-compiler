/**
 * Raw ingested-source access, distinct from typed wiki/sources entities. The
 * frozen filename allowlist is checked before a fresh handle-confined read.
 * Local ingestion identities are never exported as filesystem paths.
 */
import path from "path";
import { assertSafeSourceId, toRecord } from "../sources/source-record.js";
import { diskLocalCappedReads } from "../storage/disk-local-reads.js";
import type { LegacyLocalCappedReads } from "../storage/legacy-local-reads.js";
import { PathSafetyError } from "./path-safety.js";
import { declaredSourceImages } from "./api-source-images.js";

/** A preview is deliberately bounded, not a streaming arbitrary-file interface. */
const SOURCE_PREVIEW_BYTES = 1024 * 1024;

/** Preserve physical source line numbers, including frontmatter, in the local preview. */
export function readViewerSource(root: string, filenames: readonly string[], id: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  return readViewerSourceFrom(diskLocalCappedReads(root), filenames, id, isLoopback);
}

/** {@link readViewerSource} with the one bounded read made through `reads`; every check stays here. */
export async function readViewerSourceFrom(reads: LegacyLocalCappedReads, filenames: readonly string[], id: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  if (!id) throw new PathSafetyError("Invalid source identifier.");
  // Reuse the relative-ID contract without pretending other formats are Markdown.
  assertSafeSourceId(id.endsWith(".md") ? id : `${id}.md`);
  const base = { kind: "raw-source", id, contentAccess: isLoopback ? "available" : "loopback-only" };
  if (!filenames.includes(id)) return { ...base, health: "missing" };
  if (!id.endsWith(".md")) return { ...base, health: "unsupported" };
  const read = await reads.readCappedText(path.join("sources", id), SOURCE_PREVIEW_BYTES);
  if (read.kind !== "ok") return { ...base, health: read.kind === "absent" ? "missing" : "unavailable" };
  const { source, ...record } = toRecord(id, read.body, false);
  const locator = webLocator(source);
  const images = declaredSourceImages(read.body);
  return {
    ...base, ...record, health: "ok",
    ...(locator ? { locator } : {}),
    // Omitted when a source declares none, so sources without images are unchanged.
    ...(images.length > 0 ? { images } : {}),
    ...(isLoopback ? { body: read.body } : {}),
  };
}

/** A recorded URL is a locator, not proof that the original publication is stored. */
function webLocator(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
