/** Request-time artifact metadata and verified loopback content endpoints. */
import type { ServerResponse } from "http";
import type { ProfilePack } from "../profile/types.js";
import type { ViewerSnapshot } from "./types.js";
import { readViewerArtifact } from "./artifact-access.js";
import { writeAccessContent, writeAccessMetadata } from "./api-access-response.js";
import { writeJsonError } from "./respond.js";
import { PathSafetyError } from "./path-safety.js";

/** Handle only the registered artifact endpoints, never arbitrary filesystem paths. */
export async function handleApiArtifact(res: ServerResponse, snapshot: Pick<ViewerSnapshot, "root"> & { artifactDefinitions?: ProfilePack["artifacts"] }, url: URL, isLoopback: boolean): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await readViewerArtifact(snapshot.root, snapshot.artifactDefinitions, url.searchParams.get("ref") ?? "", isLoopback);
    if (url.pathname.endsWith("/content")) {
      writeAccessContent(res, result, typeof result.fileName === "string" ? result.fileName : "artifact.txt", url.searchParams.get("download") === "1");
    } else writeAccessMetadata(res, result);
  } catch (error) {
    if (!(error instanceof PathSafetyError)) throw error;
    writeJsonError(res, 400, "invalid_artifact_ref", "Invalid artifact reference.");
  }
}
