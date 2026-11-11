/**
 * Raw-source routes, separate from typed source entities: metadata at
 * `/api/source/<id>`, the text at `/content` (loopback only), and the pages
 * citing the source at `/cited-by`, which reads only the in-memory snapshot.
 */
import type { ServerResponse } from "http";
import type { ViewerSnapshot } from "./types.js";
import { readViewerSource } from "./source-access.js";
import { writeAccessContent, writeAccessMetadata } from "./api-access-response.js";
import { citedBy } from "./cited-by.js";
import { writeJson, writeJsonError } from "./respond.js";
import { PathSafetyError } from "./path-safety.js";

const SUBROUTES: ReadonlySet<string> = new Set(["content", "cited-by"]);

/** Decode one route segment once; nested IDs encode slashes, and traversal is rejected. */
export async function handleApiSource(res: ServerResponse, snapshot: Pick<ViewerSnapshot, "root" | "sourceFilenames" | "pages">, pathname: string, isLoopback: boolean): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const parts = pathname.slice("/api/source/".length).split("/");
  if (parts.length > 2 || (parts.length === 2 && !SUBROUTES.has(parts[1]))) {
    writeJsonError(res, 400, "invalid_source_id", "Invalid source identifier.");
    return;
  }
  try {
    const id = decodeURIComponent(parts[0]);
    if (parts[1] === "cited-by") return writeJson(res, 200, citedBy(snapshot.pages, id));
    const result = await readViewerSource(snapshot.root, snapshot.sourceFilenames, id, isLoopback);
    if (parts[1] === "content") writeAccessContent(res, result, id, false);
    else writeAccessMetadata(res, result);
  } catch (error) {
    if (!(error instanceof PathSafetyError) && !(error instanceof URIError)) throw error;
    writeJsonError(res, 400, "invalid_source_id", "Invalid source identifier.");
  }
}
