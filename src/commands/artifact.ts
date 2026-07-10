/**
 * @file src/commands/artifact.ts
 * @description Commander actions for `artifact write` / `artifact verify` — the
 * CLI surface over the artifact write path ({@link applyApprovedMutations} →
 * `applyArtifactLocked`) and the read path ({@link resolveArtifactRef}).
 *
 * `artifact write` accepts the body EXACTLY ONE way: inline `--body` (a JS
 * string, used as-is) or `--body-file` (read through the confined
 * {@link readCappedNoFollowBuffer} — O_NOFOLLOW|O_NONBLOCK, regular-file-only,
 * byte-capped — then decoded with a FATAL `TextDecoder`). The fatal decode is
 * load-bearing: invalid UTF-8 must fail closed, never silently re-encode with
 * replacement characters, because the stored hash must be over the operator's
 * ACTUAL bytes (spec §4), not a lossy reinterpretation of them.
 *
 * Every write-time refusal is one of the Task-7 error classes
 * ({@link ArtifactWriteRefusedError}, {@link ArtifactWriteDeniedError},
 * {@link ArtifactTargetNotRegularError}, {@link ArtifactTargetDirEscapesRootError}).
 * They are routed by `instanceof`, NOT by message-sniffing, so only the ONE
 * grant-hintable refusal ({@link ArtifactWriteRefusedError} — a missing
 * `LLMWIKI_TRUSTED_WRITE` grant on an otherwise-allowed write) ever prints the
 * grant hint; the rest (a planner denial, or a non-regular/escaping pre-existing
 * target) print their own message with no such advice, since a grant cannot
 * override any of them.
 *
 * `artifact verify` never reads or prints the body — only the ref and the
 * {@link resolveArtifactRef} health verdict, which itself recomputes the hash
 * over the actual on-disk bytes rather than trusting the manifest alone.
 */
import { readCappedNoFollowBuffer } from "../utils/confined-read.js";
import { MAX_ARTIFACT_BYTES } from "../artifacts/name.js";
import { applyApprovedMutations } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { formatArtifactRef } from "../artifacts/ref.js";
import type { ArtifactRef } from "../artifacts/ref.js";
import { resolveArtifactRef, declaresArtifactTypes } from "../artifacts/resolve.js";
import {
  ArtifactWriteRefusedError,
  ArtifactWriteDeniedError,
  ArtifactTargetNotRegularError,
  ArtifactTargetDirEscapesRootError,
} from "../artifacts/apply.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";

/** Parsed `artifact write` flags (commander camelCases `--body-file` to `bodyFile`). */
export interface ArtifactWriteOptions {
  type: string;
  slug: string;
  body?: string;
  bodyFile?: string;
}

/** Parsed `artifact verify` flags. */
export interface ArtifactVerifyOptions {
  type: string;
  slug: string;
  sha256: string;
}

/** A 64-character lowercase-hex sha256 digest. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Print an error in the CLI's standard red style and exit 1 — the shared fatal tail for pre-core validation. */
function failArtifact(message: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}

/** Which of `--body` / `--body-file` was given — exactly one, or a fatal exit. */
function assertExactlyOneBodySource(options: ArtifactWriteOptions): "inline" | "file" {
  const hasInline = options.body !== undefined;
  const hasFile = options.bodyFile !== undefined;
  if (hasInline === hasFile) failArtifact("provide exactly one of --body or --body-file");
  return hasInline ? "inline" : "file";
}

/**
 * Read a `--body-file` through the confined byte reader and decode it with a
 * FATAL UTF-8 `TextDecoder` — see the file overview for why this must never
 * fall back to a lossy replacement-character decode.
 */
async function readBodyFile(filePath: string): Promise<string> {
  const read = await readCappedNoFollowBuffer(filePath, MAX_ARTIFACT_BYTES);
  if (read.kind !== "ok") {
    failArtifact(
      `cannot read --body-file ${JSON.stringify(filePath)}: not a regular file, a symlink, or larger than ${MAX_ARTIFACT_BYTES} bytes`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(read.body);
  } catch {
    failArtifact(`--body-file ${JSON.stringify(filePath)} is not valid UTF-8`);
  }
}

/** Resolve the write body from EXACTLY ONE of `--body` (inline) / `--body-file` (confined, strict-UTF-8). */
async function resolveWriteBody(options: ArtifactWriteOptions): Promise<string> {
  const source = assertExactlyOneBodySource(options);
  return source === "inline" ? (options.body as string) : readBodyFile(options.bodyFile as string);
}

/** The Task-7 write-refusal taxonomy — every class {@link failWriteRefusal} routes by `instanceof`. */
const ARTIFACT_WRITE_REFUSAL_CLASSES = [
  ArtifactWriteRefusedError,
  ArtifactWriteDeniedError,
  ArtifactTargetNotRegularError,
  ArtifactTargetDirEscapesRootError,
] as const;

/**
 * Route a write-time throw to its advice-matched message and exit 1, or
 * rethrow anything outside the Task-7 taxonomy (the caller's own action
 * wrapper handles that as an unexpected error). See the file overview for why
 * only {@link ArtifactWriteRefusedError} gets the grant hint.
 */
function failWriteRefusal(err: unknown): never {
  const isRefusal = ARTIFACT_WRITE_REFUSAL_CLASSES.some((cls) => err instanceof cls);
  if (isRefusal) failArtifact((err as Error).message);
  throw err;
}

/**
 * `artifact write --type <t> --slug <s> (--body <inline> | --body-file <path>)`.
 * Builds a `cli`-origin {@link ArtifactPlannedMutation} and applies it through
 * the self-locking {@link applyApprovedMutations} (the under-lock authority
 * re-loads the profile, re-composes the decision, and gates on the operator
 * trusted-write grant — this command never trusts its own inputs as final).
 * Prints the compact {@link formatArtifactRef} of the persisted artifact on success.
 */
export async function artifactWriteCommand(options: ArtifactWriteOptions): Promise<void> {
  const body = await resolveWriteBody(options);
  const mutation: ArtifactPlannedMutation = { kind: "artifact", artifactType: options.type, slug: options.slug, body, origin: "cli" };
  try {
    const [result] = await applyApprovedMutations(process.cwd(), [mutation]);
    if (result.kind !== "artifact") throw new Error("executor returned a non-artifact result for an artifact write");
    console.log(formatArtifactRef(result.ref));
  } catch (err) {
    failWriteRefusal(err);
  }
}

/**
 * `artifact verify --type <t> --slug <s> --sha256 <hex>`. Prints the
 * {@link resolveArtifactRef} health verdict for a hash-pinned ref — metadata and
 * health ONLY, never the artifact body. Exits 1 with a dedicated message (not a
 * dangling verdict) when the project has no active profile or that profile
 * declares no artifact types at all, since no ref could ever resolve there.
 */
export async function artifactVerifyCommand(options: ArtifactVerifyOptions): Promise<void> {
  const loaded = await loadNonDefaultProfile(process.cwd());
  if (!loaded || !declaresArtifactTypes(loaded.profile)) {
    failArtifact("no artifact types declared by the active profile");
  }
  if (!SHA256_HEX_PATTERN.test(options.sha256)) {
    failArtifact(`--sha256 must be 64 lowercase hex characters, got ${JSON.stringify(options.sha256)}`);
  }
  const ref: ArtifactRef = { artifactType: options.type, slug: options.slug, sha256: options.sha256 };
  const { health } = await resolveArtifactRef(process.cwd(), loaded.profile, ref);
  console.log(`ref:    ${formatArtifactRef(ref)}`);
  console.log(`health: ${health}`);
}
