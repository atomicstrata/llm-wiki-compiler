/**
 * Raw candidate rejection deliberately bypasses promotion admission so a record
 * whose validated-answer metadata is malformed can still be archived by its
 * explicit safe id. Only the filename identifies the record; its JSON is never
 * parsed or trusted for paths. Custody capture keeps the store's confinement,
 * regular-file and race guards without sanitizing the archived bytes.
 */
import { captureCandidateCustody } from "./candidate-custody.js";
import { archiveCandidate } from "./candidates.js";
import * as output from "../utils/output.js";

/** Report absence while leaving unsafe ids and genuine store failures visible. */
export async function loadRejectableCandidateOrFail(root: string, id: string): Promise<boolean> {
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody !== null) return true;
  output.status("!", output.error(`Candidate not found or removed during review: ${id}`));
  process.exitCode = 1;
  return false;
}

/** Archive the original queue file through the custody move without admission. */
export async function archiveRejectedCandidate(root: string, id: string): Promise<boolean> {
  if (!await loadRejectableCandidateOrFail(root, id)) return false;
  let archived = false;
  try {
    archived = await archiveCandidate(root, id);
  } catch {
    archived = false;
  }
  if (!archived) {
    output.status("!", output.error("Candidate could not be archived safely."));
    process.exitCode = 1;
  }
  return archived;
}
