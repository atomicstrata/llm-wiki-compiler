/**
 * Content-addressed artifact store: VALIDATED canonical paths, the sidecar manifest,
 * the byte-hash, confined atomic writes, and NO-FOLLOW-LEAF + PARENT-CONFINED + CAPPED
 * reads. Path segments are slug/filename-validated at the boundary so a caller-supplied
 * slug can never normalize into another in-project area. Reads open the LITERAL leaf
 * O_NOFOLLOW (a symlinked leaf fails closed) under a realpath'd parent confirmed equal
 * to the expected dir and re-confirmed after the read (TOCTOU). The leaf is NEVER
 * realpath'd — that would follow an in-dir symlink and defeat O_NOFOLLOW.
 */
import path from "path";
import { createHash } from "crypto";
import { atomicWrite } from "../utils/markdown.js";
import {
  readConfinedLeaf,
  openConfinedLeaf,
  readWithinCapOrElse,
  type CappedLeafRead,
  type ReadLeafOptions,
} from "../utils/confined-read.js";
import { isSlugSafe, isSafeFilenameComponent } from "../profile/identity.js";

// Re-exported from its shared home so the artifact write-side preflight
// (`apply.ts`) keeps root-anchoring against the SAME primitive the read side
// uses, importing it from the store — its natural artifact-domain surface.
export { resolveExpectedReal } from "../utils/confined-read.js";

/** Thrown when an artifact path segment is not safe. */
export class ArtifactPathError extends Error {
  constructor(what: string, value: string) {
    super(`unsafe artifact ${what}: ${JSON.stringify(value)}`);
    this.name = "ArtifactPathError";
  }
}

export interface ArtifactManifest {
  artifactType: string; slug: string; sha256: string;
  bytes: number; contentKind: "json" | "text"; writtenAt: string;
}

export type ManifestRead =
  | { kind: "ok"; manifest: ArtifactManifest } | { kind: "absent" }
  | { kind: "unavailable" } | { kind: "malformed" };

/** Build the two targets + expected dir, validating every segment first. */
export function artifactPaths(root: string, artifactType: string, slug: string, fileName: string): { bytesPath: string; manifestPath: string; expectedDir: string } {
  if (!isSlugSafe(artifactType)) throw new ArtifactPathError("type", artifactType);
  if (!isSlugSafe(slug)) throw new ArtifactPathError("slug", slug);
  if (!isSafeFilenameComponent(fileName)) throw new ArtifactPathError("fileName", fileName);
  const expectedDir = path.join(root, "artifacts", artifactType, slug);
  const bytesPath = path.join(expectedDir, fileName);
  return { bytesPath, manifestPath: `${bytesPath}.manifest.json`, expectedDir };
}

export function hashArtifactBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function writeArtifactFiles(root: string, paths: { bytesPath: string; manifestPath: string }, body: string, manifest: ArtifactManifest): Promise<void> {
  await atomicWrite(paths.bytesPath, body, { confineRoot: root, durable: true });
  await atomicWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { confineRoot: root, durable: true });
}

/**
 * Runtime manifest shape validator — a valid-JSON but wrong-shape manifest is NOT
 * ok. Returns a FRESH object built from exactly the six allowlisted fields rather
 * than the parsed JSON itself: the on-disk manifest is adversarial input (this is
 * the same store `resolveArtifactRef` tamper-checks), so an extra planted key
 * (e.g. a smuggled `body`) must never survive validation to ride along with every
 * caller that trusts an `ArtifactManifest` — including the MCP metadata response,
 * which projects this value wholesale.
 */
export function parseManifest(raw: unknown): ArtifactManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const okStr = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!okStr(m.artifactType) || !okStr(m.slug) || !okStr(m.writtenAt)) return null;
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
  if (!Number.isInteger(m.bytes) || (m.bytes as number) < 0) return null;
  if (m.contentKind !== "json" && m.contentKind !== "text") return null;
  return {
    artifactType: m.artifactType as string,
    slug: m.slug as string,
    sha256: m.sha256,
    bytes: m.bytes as number,
    contentKind: m.contentKind,
    writtenAt: m.writtenAt as string,
  };
}

export async function readArtifactManifest(root: string, paths: { manifestPath: string; expectedDir: string }, maxBytes = 64 * 1024): Promise<ManifestRead> {
  const read = await readConfinedLeaf(root, paths.manifestPath, paths.expectedDir, maxBytes);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") return { kind: "unavailable" };
  let parsed: unknown;
  try { parsed = JSON.parse(read.body); } catch { return { kind: "malformed" }; }
  const manifest = parseManifest(parsed);
  return manifest ? { kind: "ok", manifest } : { kind: "malformed" };
}

/**
 * The artifact BODY's read-local outcome: everything {@link CappedLeafRead}
 * carries, PLUS a distinguishable `oversize` — a CONFIRMED in-root regular
 * file whose fstat'd size exceeds `maxBytes`. Deliberately NOT folded into the
 * shared `CappedLeafRead` (that would ripple to `readArtifactManifest` and
 * every other confined-leaf consumer); only `resolveArtifactRef` reads this
 * outcome, comparing `actualBytes` against the recorded (co-tamperable, not
 * cryptographically signed) `manifest.bytes` to tell a benign
 * `maxBytes`-lowering from a provable bytes divergence.
 *
 * SECURITY (see `openConfinedLeaf`): `oversize` is produced ONLY from a
 * `confirmed` open — i.e. only AFTER {@link passesPostOpenChecks} has
 * verified the leaf is the real in-root regular file. A size-over-cap leaf
 * that FAILS confinement (a symlinked parent, an inode-swap race) is
 * `unavailable`, never `oversize` — otherwise a parent-dir swap race could
 * make an out-of-root file's size masquerade as this artifact's, producing a
 * FALSE `artifact-bytes-tampered` verdict and leaking that file's byte count.
 */
export type ArtifactBodyRead = CappedLeafRead | { kind: "oversize"; actualBytes: number };

export async function readArtifactBody(root: string, paths: { bytesPath: string; expectedDir: string }, maxBytes: number, opts: ReadLeafOptions = {}): Promise<ArtifactBodyRead> {
  const opened = await openConfinedLeaf(root, paths.bytesPath, paths.expectedDir, opts);
  if (opened.kind !== "confirmed") return opened;
  return readWithinCapOrElse(opened, maxBytes, (actualBytes) => ({ kind: "oversize" as const, actualBytes }));
}
