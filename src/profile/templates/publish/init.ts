/**
 * @file src/profile/templates/publish/init.ts
 * @description Create a publisher workspace with fresh tap and publisher keypairs.
 *
 * Ordering is load-bearing: keys are created first and the manifest is written LAST.
 * The manifest's existence is the readiness signal, and it is written atomically — so
 * an interrupted init can never leave a workspace that reports itself ready.
 */
import { mkdir, readdir } from "node:fs/promises";
import { isSlugSafe } from "../../identity.js";
import type { PublisherKey } from "../signing/types.js";
import { createKeypairFile, publicKeyFingerprint } from "./keystore.js";
import { resolveWorkspacePaths, type WorkspacePaths } from "./workspace-paths.js";
import { writeWorkspace } from "./workspace-store.js";
import type { PublisherWorkspace } from "./workspace-types.js";

/** Options accepted by `template publish init`. */
export interface InitWorkspaceOptions {
  tap: string;
  publisher: string;
  tapKeyId?: string;
  publisherKeyId?: string;
  /** Injected only by tests so default key ids are deterministic. */
  now?: Date;
}

/** Public result; never carries private key bytes. */
export interface InitWorkspaceResult {
  root: string;
  tap: string;
  publisher: string;
  tapKey: PublisherKey;
  publisherKey: PublisherKey;
  fingerprints: { tap: string; publisher: string };
}

/** Initialize one publisher workspace in an empty directory. */
export async function initWorkspace(
  directory: string,
  options: InitWorkspaceOptions,
): Promise<InitWorkspaceResult> {
  const paths = resolveWorkspacePaths(directory);
  assertSlug(options.tap, "tap");
  assertSlug(options.publisher, "publisher");
  const now = options.now ?? new Date();
  const tapKeyId = options.tapKeyId ?? defaultKeyId(options.tap, "tap", now);
  const publisherKeyId = options.publisherKeyId ?? defaultKeyId(options.publisher, "publisher", now);

  await assertEmptyTarget(paths);
  await mkdir(paths.keysDir, { recursive: true, mode: 0o700 });
  const tapKey = await createKeypairFile(paths, tapKeyId, "tap");
  const publisherKey = await createKeypairFile(paths, publisherKeyId, "publisher");

  await writeWorkspace(paths, freshWorkspace(options.tap, options.publisher, tapKey, publisherKey));
  return {
    root: paths.root,
    tap: options.tap,
    publisher: options.publisher,
    tapKey,
    publisherKey,
    fingerprints: {
      tap: publicKeyFingerprint(tapKey),
      publisher: publicKeyFingerprint(publisherKey),
    },
  };
}

/** A workspace that has published nothing: sequence 0, no history, no intents. */
function freshWorkspace(
  tap: string,
  publisher: string,
  tapKey: PublisherKey,
  publisherKey: PublisherKey,
): PublisherWorkspace {
  return {
    schemaVersion: 1,
    tap,
    publisher,
    tapKey,
    publisherKey,
    sequence: 0,
    packages: [],
    rotations: [],
    tapKeyRotations: [],
    revocations: [],
    pending: [],
    coordinates: {},
  };
}

/** Refuse a non-empty target: init never merges into or overwrites existing state. */
async function assertEmptyTarget(paths: WorkspacePaths): Promise<void> {
  const entries = await readdir(paths.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries === null) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    return;
  }
  if (entries.length > 0) throw new Error("publisher workspace directory is not empty");
}

function defaultKeyId(name: string, role: string, now: Date): string {
  const month = now.toISOString().slice(0, 7);
  return `${name}-${role}-${month}`;
}

function assertSlug(value: string, label: string): void {
  if (!isSlugSafe(value)) throw new Error(`${label} must be slug-safe: ${JSON.stringify(value)}`);
}
