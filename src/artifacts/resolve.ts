/**
 * Resolve a hash-pinned artifact ref to a health verdict by verifying against the
 * ACTUAL bytes — never trusting the manifest hash alone (that would miss a bytes-only
 * tamper). Reads manifest + bytes through the confined readers, recomputes sha256 over
 * the bytes, and compares bytes↔manifest, ref↔recomputed, and (json) schema-over-bytes.
 * Bodies are read but NEVER returned (no-body-exposure).
 */
import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactRef } from "./ref.js";
import { artifactPaths, hashArtifactBody, readArtifactManifest, readArtifactBody, type ArtifactManifest } from "./store.js";
import { validateArtifactBody } from "./body-contract.js";

export type ArtifactHealth =
  | "ok" | "artifact-dangling" | "artifact-unreadable" | "artifact-bytes-tampered"
  | "artifact-schema-invalid" | "artifact-hash-mismatch" | "artifact-store-unavailable";

/**
 * Why an `artifact-store-unavailable` health arose: a genuine store fault
 * (malformed/unwritten manifest — retryable, so the write-time precondition
 * PARKS) vs a manifest integrity-lie (identity/contentKind/byte-count mismatch —
 * the manifest is adversarial, so the precondition DENIES). This lets the enforcer
 * split the OVERLOADED `artifact-store-unavailable` string WITHOUT widening the
 * public {@link ArtifactHealth} enum (FT3 deliberately avoided that).
 */
export type StoreFaultReason = "genuine-fault" | "integrity-lie";

/**
 * The full resolve verdict: the health, the parsed manifest (when it parsed at
 * all), and — ONLY when `health` is `artifact-store-unavailable` — the
 * discriminated {@link StoreFaultReason}. Read surfaces (lint/status/MCP) destructure
 * `{ health }` / `{ health, manifest }` and ignore `storeFault`, so this is additive.
 */
export interface ArtifactResolution {
  health: ArtifactHealth;
  manifest?: ArtifactManifest;
  storeFault?: StoreFaultReason;
}

/**
 * True when the loaded profile declares at least one artifact type. Shared by
 * `artifact verify` (CLI) and `verifyArtifact` (SDK) so both surfaces refuse
 * a zero-artifact-types profile identically instead of drifting.
 */
export function declaresArtifactTypes(profile: { artifacts?: Record<string, unknown> }): boolean {
  return Object.keys(profile.artifacts ?? {}).length > 0;
}

/**
 * Thrown when verifying an artifact ref is requested for a project with no
 * active non-default profile, or one that declares NO artifact types at all.
 * In either case no ref could ever resolve, so verify fails CLOSED with a
 * dedicated, catchable error rather than falling through to
 * {@link resolveArtifactRef} and surfacing a misleading `"artifact-dangling"`
 * verdict. Mirrors {@link LifecycleTransitionUnavailableError}'s reason-coded
 * shape (`src/trust/lifecycle-apply.ts`).
 */
export class ArtifactVerifyUnavailableError extends Error {
  constructor(reason: "no-profile" | "no-artifact-types", detail: string) {
    super(`cannot verify artifact: ${detail}`);
    this.name = "ArtifactVerifyUnavailableError";
    void reason;
  }
}

/**
 * Terminal checks once a body has come back `ok` (identity/kind/oversize have
 * already cleared): the manifest's declared length, its own recorded hash, the
 * ref's pinned hash, and the write-time schema — in that order.
 */
function verifyOkBody(def: ArtifactTypeDef, ref: ArtifactRef, m: ArtifactManifest, body: string): { health: ArtifactHealth; storeFault?: StoreFaultReason } {
  // A byte-count divergence is a manifest lying about its own body length — an
  // integrity-lie the write-time precondition must DENY, not a retryable fault.
  if (m.bytes !== Buffer.byteLength(body, "utf8")) return { health: "artifact-store-unavailable", storeFault: "integrity-lie" };
  const recomputed = hashArtifactBody(body);
  if (recomputed !== m.sha256) return { health: "artifact-bytes-tampered" };
  if (recomputed !== ref.sha256) return { health: "artifact-hash-mismatch" };
  // The SAME validator the write plan ran (src/artifacts/body-contract.ts) — the read
  // side re-verifies with identical rules, so write/read contracts cannot drift.
  if (validateArtifactBody(def, body).length > 0) return { health: "artifact-schema-invalid" };
  return { health: "ok" };
}

/** Spread `manifest` into a resolve return only when the manifest itself parsed — omits the key entirely (rather than setting it `undefined`) for the absent/malformed/undeclared-type cases. */
function withManifest(manifest: ArtifactManifest | undefined): { manifest?: ArtifactManifest } {
  return manifest ? { manifest } : {};
}

/**
 * The MANIFEST-ONLY integrity check: a parsed manifest that LIES about its identity
 * (artifactType/slug) or contentKind is an integrity-lie the write-time precondition
 * DENIES. Never dereferences the body, so {@link resolveArtifactRef} applies it the
 * moment the manifest parses — BEFORE any body-readability check — so an unreadable
 * body can never launder a lie into a park (OQ10). Returns `undefined` when the
 * manifest is honest on these fields (the byte-count/sha checks live in verifyOkBody,
 * which genuinely needs the body bytes).
 */
function manifestIntegrityLie(def: ArtifactTypeDef, ref: ArtifactRef, m: ArtifactManifest): ArtifactResolution | undefined {
  if (m.artifactType !== ref.artifactType || m.slug !== ref.slug) return { health: "artifact-store-unavailable", storeFault: "integrity-lie", manifest: m };
  if (m.contentKind !== def.contentKind) return { health: "artifact-store-unavailable", storeFault: "integrity-lie", manifest: m };
  return undefined;
}

export async function resolveArtifactRef(root: string, profile: ProfilePack, ref: ArtifactRef): Promise<ArtifactResolution> {
  const def = profile.artifacts?.[ref.artifactType];
  if (!def) return { health: "artifact-dangling" }; // undeclared type resolves to dangling on read; no manifest could ever exist
  const paths = artifactPaths(root, ref.artifactType, ref.slug, def.fileName);
  const manifest = await readArtifactManifest(root, paths);
  const body = await readArtifactBody(root, paths, def.maxBytes);
  // Carry the PARSED manifest on every return below, independent of the overall
  // health verdict (not gated on `health === "ok"`): MCP's `verify_artifact`
  // shows manifest metadata whenever the manifest file itself parses — e.g. a
  // dangling body under an otherwise-valid manifest — so a caller consuming
  // this return for metadata must see the same thing resolve saw, in one read.
  const parsed = manifest.kind === "ok" ? manifest.manifest : undefined;
  // Integrity-lie check FIRST — before any body-readability check — so an unreadable
  // body can never launder an identity/kind lie into a park (see {@link manifestIntegrityLie}).
  if (manifest.kind === "ok") {
    const lie = manifestIntegrityLie(def, ref, manifest.manifest);
    if (lie) return lie;
  }
  // Discriminate: absent → dangling; a raw fault → unreadable; corrupt/wrong-shape manifest → store-unavailable.
  if (manifest.kind === "absent" || body.kind === "absent") return { health: "artifact-dangling", ...withManifest(parsed) };
  if (manifest.kind === "unavailable" || body.kind === "unavailable") return { health: "artifact-unreadable", ...withManifest(parsed) };
  if (manifest.kind === "malformed") return { health: "artifact-store-unavailable", storeFault: "genuine-fault" }; // never parsed — nothing to carry
  const m = manifest.manifest;
  if (body.kind === "oversize") {
    // The on-disk body exceeds `def.maxBytes` but is CONFIRMED in-root (see
    // `readArtifactBody`'s doc) — we cannot recompute its sha at this size, so
    // the recorded, co-tamperable `manifest.bytes` length (NOT a cryptographic
    // signature) is the strongest available signal: a divergence proves the
    // bytes changed (tampered); equality means the artifact was written
    // honestly and only the CURRENT, lowered `maxBytes` now excludes it
    // (benign policy — stays a park/warning, not an alarm).
    return { health: body.actualBytes !== m.bytes ? "artifact-bytes-tampered" : "artifact-unreadable", manifest: m };
  }
  return { ...verifyOkBody(def, ref, m, body.body), manifest: m };
}
