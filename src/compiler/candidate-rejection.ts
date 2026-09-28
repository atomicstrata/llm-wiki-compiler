/**
 * Raw candidate rejection deliberately bypasses promotion admission so a record
 * whose validated-answer metadata is malformed can still be archived by its
 * explicit safe id. Only the filename identifies the record; its JSON is never
 * parsed or trusted for paths. Custody capture keeps the store's confinement,
 * regular-file and race guards without sanitizing the archived bytes.
 * One custody capture feeds both the caller's pre-archive step and the move,
 * so the step sees exactly the bytes that are archived.
 */
import { captureCandidateCustody, moveCandidateWithCustody } from "./candidate-custody.js";
import * as output from "../utils/output.js";

/** Report absence while leaving unsafe ids and genuine store failures visible. */
export async function loadRejectableCandidateOrFail(root: string, id: string): Promise<boolean> {
  if (await captureCandidateCustody(root, id, undefined, "public") !== null) return true;
  return reportMissing(id);
}

/**
 * Archive the original queue file through the custody move without admission.
 * `beforeArchive` receives the captured bytes; a throw refuses the rejection
 * and leaves the candidate pending. The move is bound to that same capture.
 */
export async function archiveRejectedCandidate(
  root: string,
  id: string,
  beforeArchive?: (bytes: Buffer) => Promise<void>,
): Promise<boolean> {
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody === null) return reportMissing(id);
  await beforeArchive?.(custody.bytes);
  let archived = false;
  try {
    archived = await moveCandidateWithCustody({ root, fileId: id, direction: "archive", receipt: custody.receipt }, "public");
  } catch {
    archived = false;
  }
  if (!archived) {
    output.status("!", output.error("Candidate could not be archived safely."));
    process.exitCode = 1;
  }
  return archived;
}

/** Shared not-found refusal for the pre-lock check and the under-lock archive. */
function reportMissing(id: string): false {
  output.status("!", output.error(`Candidate not found or removed during review: ${id}`));
  process.exitCode = 1;
  return false;
}
