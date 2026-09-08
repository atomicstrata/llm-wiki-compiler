/**
 * Request-time artifact projection. Metadata and optional local bytes are derived
 * from one verified read; no caller may verify a path and subsequently reopen it.
 */
import type { ProfilePack } from "../profile/types.js";
import { parseArtifactRef } from "../artifacts/ref.js";
import { readVerifiedArtifact } from "../artifacts/resolve.js";
import { PathSafetyError } from "./path-safety.js";

/** Verify a pinned ref and expose only declared metadata outside loopback. */
export async function readViewerArtifact(root: string, artifacts: ProfilePack["artifacts"], raw: string, isLoopback: boolean): Promise<Record<string, unknown>> {
  const ref = parseArtifactRef(raw);
  if (!ref) throw new PathSafetyError("Invalid artifact reference.");
  const result = await readVerifiedArtifact(root, { artifacts }, ref);
  const { body, storeFault: _fault, ...resolution } = result;
  const def = artifacts && Object.hasOwn(artifacts, ref.artifactType) ? artifacts[ref.artifactType] : undefined;
  const metadata = body !== undefined && def?.contentKind === "json"
    ? declaredMetadata(JSON.parse(body), Object.keys(def.metadata ?? {})) : undefined;
  return { kind: "artifact", ref: raw, ...resolution,
    contentAccess: isLoopback ? "available" : "loopback-only",
    ...(def ? { fileName: def.fileName } : {}),
    ...(metadata ? { metadata } : {}),
    ...(body !== undefined && isLoopback ? { body } : {}) };
}

/** Exclude undeclared JSON fields, even when the artifact permits extra keys. */
function declaredMetadata(parsed: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(parsed, name)).map((name) => [name, parsed[name]]));
}
