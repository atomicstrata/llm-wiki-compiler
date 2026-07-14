/**
 * @file src/profile/templates/publish/workspace-store.ts
 * @description Confined, capped, atomic persistence for authoritative workspace
 * state. Written bytes are re-parsed before they land, so the store can never
 * persist a manifest its own parser would refuse to read back.
 */
import { atomicWrite } from "../../../utils/atomic-write.js";
import { readConfinedLeaf } from "../../../utils/confined-read.js";
import { MAX_WORKSPACE_BYTES, parsePublisherWorkspace } from "./workspace-parse.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import type { PublisherWorkspace } from "./workspace-types.js";

/** Read authoritative state; a symlinked, oversized, or absent leaf fails closed. */
export async function readWorkspace(paths: WorkspacePaths): Promise<PublisherWorkspace> {
  const read = await readConfinedLeaf(paths.root, paths.manifestFile, paths.root, MAX_WORKSPACE_BYTES);
  if (read.kind !== "ok") throw new Error("publisher workspace is missing, symlinked, or unreadable");
  return parsePublisherWorkspace(read.body);
}

/** Atomically replace authoritative state, re-validating the bytes before they land. */
export async function writeWorkspace(paths: WorkspacePaths, workspace: PublisherWorkspace): Promise<void> {
  const text = `${JSON.stringify(workspace, null, 2)}\n`;
  parsePublisherWorkspace(text);
  await atomicWrite(paths.manifestFile, text, { confineRoot: paths.root, durable: true, mode: 0o600 });
}
