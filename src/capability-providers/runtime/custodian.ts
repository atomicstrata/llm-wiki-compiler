/**
 * @file src/capability-providers/runtime/custodian.ts
 * @description Concrete evidence custodian. It reopens every claimed output
 * through the confined no-follow reader, reads the exact confirmed size under
 * the scan-byte and wall-time budgets, then runs the combined content pass —
 * SHA-256 digest, declared media-type magic-byte check, and the hardened
 * encoding-aware credential-reflection matcher — over those bytes. It rejects
 * undeclared, missing, unsafe, content-mismatched, or secret-bearing outputs.
 * Custody is result-level and atomic (D6.4): the first exhausted or rejected
 * output fails the whole result and promotes zero artifacts; the pre-launch
 * feasibility gate remains the separate before-execution check.
 */
import { createHash } from "node:crypto";
import { neutralisedProviderText, quotedProviderToken } from "./untrusted-text.js";
import { opendir } from "node:fs/promises";
import path from "node:path";
import { openConfinedLeaf } from "../../utils/confined-read.js";
import { assertNoCredentialReflection } from "../authority/credentials.js";
import { parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  AcceptedArtifactV1, CustodyOutcomeV1, DeclaredArtifactOutputV1, EvidenceRefV1,
} from "./result-admission.js";
import type { RuntimeJsonObjectV1, RuntimeJsonValueV1 } from "./types.js";

const CHUNK_BYTES = 64 * 1024;

/** Host-owned inputs for one invocation's streaming custody pass. */
export interface StreamingCustodianOptionsV1 {
  readonly outputRoot: string;
  readonly declaredOutputs: readonly DeclaredArtifactOutputV1[];
  readonly scanBytes: number;
  readonly wallTimeMs: number;
  /** Aggregate accepted-output-byte ceiling from the resolved grant bounds (F2). */
  readonly outputBytes?: number;
  /** Output-file count ceiling from the resolved grant bounds (F2). */
  readonly outputFiles?: number;
  /** Per-output declared maximum byte counts; bounds a single read (F2). */
  readonly maxOutputBytesById?: ReadonlyMap<string, number>;
  readonly secrets?: readonly Uint8Array[];
  /**
   * Bytes already debited against the shared scan allowance before terminal
   * custody runs — the sum of the broker-response bodies materialized during the
   * invocation (F3). Output custody continues from this total so broker bodies
   * and provider outputs draw on one allowance, not one each.
   */
  readonly initialScanBytes?: number;
  /** Copy accepted output bytes into durable host evidence (F1). */
  readonly retainEvidence?: (bytes: Buffer, digest: Sha256Digest) => Promise<EvidenceRefV1>;
  /** Roll back evidence written during a pass that does not accept (P4). */
  readonly discardEvidence?: (refs: readonly EvidenceRefV1[]) => Promise<void>;
  readonly now?: () => number;
}

type ExhaustionDimensionV1 = "custodyScanBytes" | "custodyWallTimeMs";
interface ClaimV1 { readonly outputId: string; readonly outputToken: string }
interface CustodyState { scanned: number; outputBytes: number; readonly start: number }
type EnumerationV1 = { readonly files: readonly string[] } | { readonly unsafe: string };
type OneOutcome =
  | { readonly accepted: AcceptedArtifactV1 }
  | { readonly exhausted: ExhaustionDimensionV1 }
  | { readonly rejected: string };

/** Build a custodian that admits only claimed, in-budget, secret-free outputs. */
export function createStreamingCustodian(options: StreamingCustodianOptionsV1) {
  const now = options.now ?? (() => Date.now());
  return {
    custody: (providerResult: RuntimeJsonObjectV1): Promise<CustodyOutcomeV1> =>
      custodyFailClosed(options, now, providerResult),
  };
}

/**
 * The single fail-closed seam for the whole custody I/O surface (P1–P3). Any
 * fault while enumerating the output root, reading an output, or retaining
 * evidence resolves to a closed `rejected` outcome instead of a raw rejected
 * promise — a read fault is "couldn't read", never silently "nothing there". On
 * any non-accepted outcome the evidence written during the pass is rolled back,
 * so a rejected result promotes and retains nothing (P4).
 */
async function custodyFailClosed(
  options: StreamingCustodianOptionsV1, now: () => number, providerResult: RuntimeJsonObjectV1,
): Promise<CustodyOutcomeV1> {
  const written: EvidenceRefV1[] = [];
  try {
    const outcome = await runCustody(options, now, providerResult, written);
    if (outcome.kind !== "accepted") await rollbackEvidence(options, written);
    return outcome;
  } catch (error) {
    await rollbackEvidence(options, written);
    return { kind: "rejected", reason: `custody could not complete: ${errorMessage(error)}` };
  }
}

/** Best-effort rollback of evidence written before a non-accepted outcome (P4). */
async function rollbackEvidence(
  options: StreamingCustodianOptionsV1, written: readonly EvidenceRefV1[],
): Promise<void> {
  if (written.length === 0 || !options.discardEvidence) return;
  await options.discardEvidence(written).catch(() => {});
}

/** The most bytes of a caught fault's message carried into the custody rejection reason. */
const MAX_FAULT_MESSAGE_BYTES = 256;

/**
 * A caught fault's message is NOT host-authored text: a filesystem error names the
 * path it failed on, and under the provider-owned output root that path carries
 * provider-chosen directory names. It gets the same one-line, byte-bounded treatment
 * as every other provider string before it reaches the durable detail.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) return "unexpected custody fault";
  return neutralisedProviderText(error.message, MAX_FAULT_MESSAGE_BYTES);
}

async function runCustody(
  options: StreamingCustodianOptionsV1, now: () => number,
  providerResult: RuntimeJsonObjectV1, written: EvidenceRefV1[],
): Promise<CustodyOutcomeV1> {
  const claims = readClaims(providerResult.artifactClaims);
  if (claims === null) return { kind: "rejected", reason: "provider artifact claims are malformed" };
  const preflight = await preflightOutputRoot(options, claims);
  if (preflight) return preflight;
  const state: CustodyState = { scanned: options.initialScanBytes ?? 0, outputBytes: 0, start: now() };
  // The broker-response bodies already debited against the shared allowance can
  // exhaust it on their own, even with no output to trigger the per-output check.
  if (state.scanned > options.scanBytes) return { kind: "exhausted", dimension: "custodyScanBytes" };
  const artifacts: AcceptedArtifactV1[] = [];
  for (const claim of claims) {
    const outcome = await custodyOne(options, now, state, claim, written);
    if ("exhausted" in outcome) return { kind: "exhausted", dimension: outcome.exhausted };
    if ("rejected" in outcome) return { kind: "rejected", reason: outcome.rejected };
    artifacts.push(outcome.accepted);
  }
  return { kind: "accepted", artifacts: Object.freeze(artifacts), scanBytes: state.scanned };
}

/**
 * Enforce the output namespace before any bytes are read: every file present in
 * the output root must correspond to a claimed token, no non-regular entry may
 * be present, and the actual file count must fit the resolved output-file
 * ceiling (F2). This rejects smuggled files a claim-only walk would ignore.
 */
async function preflightOutputRoot(
  options: StreamingCustodianOptionsV1, claims: readonly ClaimV1[],
): Promise<CustodyOutcomeV1 | null> {
  const enumeration = await enumerateOutputFiles(options.outputRoot);
  // Entry names come from the PROVIDER-owned output directory: neutralised and quoted like any provider token.
  if ("unsafe" in enumeration) return { kind: "rejected", reason: `output entry ${quotedProviderToken(enumeration.unsafe)} is not a regular file` };
  const claimed = new Set(claims.map((claim) => claim.outputToken));
  const unclaimed = enumeration.files.find((file) => !claimed.has(file));
  if (unclaimed !== undefined) return { kind: "rejected", reason: `unclaimed output file present: ${quotedProviderToken(unclaimed)}` };
  if (options.outputFiles !== undefined && enumeration.files.length > options.outputFiles) {
    return { kind: "rejected", reason: `output file count ${enumeration.files.length} exceeds the ceiling ${options.outputFiles}` };
  }
  return null;
}

/** Recursively enumerate regular-file relative paths, flagging any non-regular entry. */
async function enumerateOutputFiles(root: string): Promise<EnumerationV1> {
  const files: string[] = [];
  const unsafe = await walkOutputDir(root, "", files);
  return unsafe === null ? { files } : { unsafe };
}

async function walkOutputDir(root: string, rel: string, files: string[]): Promise<string | null> {
  const dir = await opendir(path.join(root, rel));
  for await (const entry of dir) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const unsafe = await walkOutputDir(root, childRel, files);
      if (unsafe !== null) return unsafe;
    } else if (entry.isFile()) {
      files.push(childRel);
    } else {
      return childRel;
    }
  }
  return null;
}

async function custodyOne(
  options: StreamingCustodianOptionsV1, now: () => number, state: CustodyState,
  claim: ClaimV1, written: EvidenceRefV1[],
): Promise<OneOutcome> {
  if (!options.declaredOutputs.some((output) => output.outputId === claim.outputId)) {
    return { rejected: `output ${quotedProviderToken(claim.outputId)} is not a declared output` };
  }
  const leaf = path.join(options.outputRoot, claim.outputToken);
  const opened = await openConfinedLeaf(options.outputRoot, leaf, options.outputRoot);
  if (opened.kind === "absent") return { rejected: `output ${quotedProviderToken(claim.outputId)} is missing` };
  if (opened.kind !== "confirmed") return { rejected: `output ${quotedProviderToken(claim.outputId)} is unavailable or unsafe` };
  try {
    const bounded = boundOpenedOutput(options, state, claim, opened.size);
    if (bounded) return bounded;
    return await streamOutput(options, now, state, claim, opened, written);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Enforce per-file, aggregate output-byte, and scan-byte ceilings before allocating (F2/P5). */
function boundOpenedOutput(
  options: StreamingCustodianOptionsV1, state: CustodyState, claim: ClaimV1, size: number,
): OneOutcome | null {
  const perFileMax = options.maxOutputBytesById?.get(claim.outputId);
  if (perFileMax !== undefined && size > perFileMax) {
    return { rejected: `output ${quotedProviderToken(claim.outputId)} size ${size} exceeds its declared maximum ${perFileMax}` };
  }
  if (options.outputBytes !== undefined && state.outputBytes + size > options.outputBytes) {
    return { rejected: `aggregate output bytes ${state.outputBytes + size} exceed the ceiling ${options.outputBytes}` };
  }
  if (state.scanned + size > options.scanBytes) return { exhausted: "custodyScanBytes" };
  return null;
}

/** Declared media-type leading-byte signatures the content pass enforces. */
const MEDIA_TYPE_MAGIC: ReadonlyMap<string, readonly number[]> = new Map([
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/zip", [0x50, 0x4b, 0x03, 0x04]],
  ["application/gzip", [0x1f, 0x8b]],
]);

async function streamOutput(
  options: StreamingCustodianOptionsV1, now: () => number, state: CustodyState,
  claim: ClaimV1, opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  written: EvidenceRefV1[],
): Promise<OneOutcome> {
  const isExpired = () => now() - state.start > options.wallTimeMs;
  if (isExpired()) return { exhausted: "custodyWallTimeMs" };
  const bytes = await readFully(opened, isExpired);
  if (bytes === "expired") return { exhausted: "custodyWallTimeMs" };
  if (bytes === "changed") return { rejected: `output ${quotedProviderToken(claim.outputId)} changed while reading` };
  state.scanned += bytes.byteLength;
  state.outputBytes += bytes.byteLength;
  const rejection = validateContent(options, claim, bytes);
  if (rejection) return { rejected: rejection };
  const digest = parseSha256Digest(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const evidence = options.retainEvidence ? await options.retainEvidence(bytes, digest) : undefined;
  if (evidence) written.push(evidence);
  return { accepted: acceptedArtifact(options, claim, bytes.byteLength, digest, evidence) };
}

/**
 * Read the exact confirmed size, checking the wall-time deadline on every chunk
 * so a large output cannot outlast the budget mid-read, then require the handle
 * to be unchanged. Allocation is bounded by the per-file and scan-byte ceilings
 * already enforced before this call.
 */
async function readFully(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  isExpired: () => boolean,
): Promise<Buffer | "changed" | "expired"> {
  const buffer = Buffer.allocUnsafe(opened.size);
  let position = 0;
  while (position < opened.size) {
    if (isExpired()) return "expired";
    const { bytesRead } = await opened.handle.read(buffer, position, Math.min(CHUNK_BYTES, opened.size - position), position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  const after = await opened.handle.stat();
  if (position !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) return "changed";
  return buffer;
}

/** Combined declared-media-type magic and encoding-aware secret-reflection pass. */
function validateContent(options: StreamingCustodianOptionsV1, claim: ClaimV1, bytes: Buffer): string | null {
  const declared = options.declaredOutputs.find((output) => output.outputId === claim.outputId);
  if (declared && !magicMatches(declared.mediaType, bytes)) {
    return `output ${quotedProviderToken(claim.outputId)} content does not match its declared media type`;
  }
  if (secretReflected(options.secrets ?? [], bytes)) return `output ${quotedProviderToken(claim.outputId)} reflects a secret`;
  return null;
}

function magicMatches(mediaType: string, bytes: Buffer): boolean {
  const signature = MEDIA_TYPE_MAGIC.get(mediaType);
  if (!signature) return true;
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** Reuse the hardened, encoding-aware credential matcher over the output bytes. */
function secretReflected(secrets: readonly Uint8Array[], bytes: Buffer): boolean {
  const needles = secrets.filter((secret) => secret.length > 0).map((secret) => Buffer.from(secret));
  if (needles.length === 0) return false;
  try {
    assertNoCredentialReflection(needles, {
      urls: [], headers: [], errors: [], status: [], frames: [],
      stdout: [], stderr: [], receipts: [], retainedEvidence: [bytes],
    });
    return false;
  } catch { return true; }
}

function acceptedArtifact(
  options: StreamingCustodianOptionsV1, claim: ClaimV1, byteCount: number,
  digest: Sha256Digest, evidence: EvidenceRefV1 | undefined,
): AcceptedArtifactV1 {
  const declared = options.declaredOutputs.find((output) => output.outputId === claim.outputId);
  return Object.freeze({
    outputId: claim.outputId, mediaType: declared?.mediaType ?? "application/octet-stream",
    digest, byteCount, ...(evidence ? { evidence } : {}),
  });
}

function readClaims(value: RuntimeJsonValueV1 | undefined): ClaimV1[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const claims: ClaimV1[] = [];
  for (const entry of value) {
    const claim = readClaim(entry);
    if (claim === null) return null;
    claims.push(claim);
  }
  return claims;
}

function readClaim(entry: RuntimeJsonValueV1): ClaimV1 | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as RuntimeJsonObjectV1;
  if (typeof record.outputId !== "string" || typeof record.outputToken !== "string"
    || !safeToken(record.outputToken)) return null;
  return Object.freeze({ outputId: record.outputId, outputToken: record.outputToken });
}

function safeToken(token: string): boolean {
  if (token.length === 0 || token.startsWith("/") || token.includes("\\") || token.includes("\0")) return false;
  return !token.split("/").some((part) => part === "" || part === "." || part === "..");
}
