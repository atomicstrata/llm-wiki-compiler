/**
 * @file src/local-workflow-host/live-target.ts
 * @description Core observation of exact live page bytes under the current
 * profile's namespace and existing confined-read checks.
 */
import { createHash } from "node:crypto";
import { readConfinedPage } from "../utils/confined-read.js";
import { buildLiveRegistryEntry, buildNamespaceDirs } from "../utils/page-registry.js";
import { loadProfile } from "../profile/load.js";
import type { VerifierLiveTargetV1 } from "../workflow-history/types.js";
import { WorkflowVerifierError } from "./verifier-error.js";

/** Exact SHA-256 digest of one confined live page's raw Markdown bytes. */
export async function readLiveTargetDigest(root: string, pageId: string): Promise<VerifierLiveTargetV1> {
  const loaded = await loadProfile(root);
  const entry = await buildLiveRegistryEntry(root, pageId, buildNamespaceDirs(loaded.profile));
  if (entry === null) throw new WorkflowVerifierError("live-target-unavailable");
  const text = await readConfinedPage(entry.capturedRealpath, entry.expectedCanonicalDir);
  if (text === null) throw new WorkflowVerifierError("live-target-unavailable");
  const contentDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  return { pageId, contentDigest };
}
