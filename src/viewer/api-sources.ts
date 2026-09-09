/** Raw-source metadata and content routes, separate from typed source entities. */
import type { ServerResponse } from "http";
import type { ViewerSnapshot } from "./types.js";
import { readViewerSource } from "./source-access.js";
import { writeAccessContent, writeAccessMetadata } from "./api-access-response.js";
import { writeJsonError } from "./respond.js";
import { PathSafetyError } from "./path-safety.js";

/** Decode one basename once; separators and traversal fail the source-store guard. */
export async function handleApiSource(res: ServerResponse, snapshot: Pick<ViewerSnapshot, "root" | "sourceFilenames">, pathname: string, isLoopback: boolean): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const parts = pathname.slice("/api/source/".length).split("/");
  if (parts.length > 2 || (parts.length === 2 && parts[1] !== "content")) {
    writeJsonError(res, 400, "invalid_source_id", "Invalid source identifier.");
    return;
  }
  try {
    const id = decodeURIComponent(parts[0]);
    const result = await readViewerSource(snapshot.root, snapshot.sourceFilenames, id, isLoopback);
    if (parts[1] === "content") writeAccessContent(res, result, id, false);
    else writeAccessMetadata(res, result);
  } catch (error) {
    if (!(error instanceof PathSafetyError) && !(error instanceof URIError)) throw error;
    writeJsonError(res, 400, "invalid_source_id", "Invalid source identifier.");
  }
}
