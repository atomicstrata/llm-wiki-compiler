/**
 * @file test/fixtures/template-publish-distribution.ts
 * @description Builds production-signed static template distributions for the
 * frozen Slice A CLI oracle without introducing an alternate signing protocol.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseTemplateCoordinate } from "../../src/profile/templates/signing/protocol.js";
import type { SignedPackageEnvelope, SignedTapIndex } from "../../src/profile/templates/signing/types.js";
import { signedIndex, signedPackage, TAP_KEY } from "./template-signing.js";

const CLI = path.resolve("dist/cli.js");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Maximum time any compiled publisher-verifier CLI assertion may wait. */
export const CLI_TIMEOUT_MS = 5_000;

export interface PublishDistribution {
  root: string;
  directory: string;
  keyFile: string;
  packageFile: string;
  envelope: SignedPackageEnvelope;
  index: SignedTapIndex;
}

export interface VerifyResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Create a current, one-package distribution signed by the production fixtures. */
export async function createPublishDistribution(
  envelope: SignedPackageEnvelope = signedPackage(),
): Promise<PublishDistribution> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-publish-verify-"));
  const directory = path.join(root, "dist");
  const digest = digestHex(envelope.payloadDigest);
  const packageFile = path.join(directory, "packages", "sha256", `${digest}.json`);
  const keyFile = path.join(root, "tap-public-key.txt");
  const networkGuard = path.join(root, "deny-network.mjs");
  await Promise.all([
    path.dirname(packageFile),
    ...writableEnvironmentDirectories(root),
  ].map((directoryPath) => mkdir(directoryPath, { recursive: true })));
  await writeFile(packageFile, JSON.stringify(envelope), "utf8");
  await writeFile(keyFile, `${TAP_KEY.publicKey}\n`, "utf8");
  await writeFile(networkGuard, networkGuardSource(), "utf8");
  const index = currentIndex(envelope);
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index), "utf8");
  return { root, directory, keyFile, packageFile, envelope, index };
}

/** Replace the index with another correctly signed snapshot. */
export async function writeSignedDistributionIndex(
  fixture: PublishDistribution,
  overrides: Partial<SignedTapIndex>,
): Promise<SignedTapIndex> {
  const index = signedIndex({
    generatedAt: fixture.index.generatedAt,
    expiresAt: fixture.index.expiresAt,
    packages: fixture.index.packages,
    ...overrides,
  });
  await writeFile(path.join(fixture.directory, "index.json"), JSON.stringify(index), "utf8");
  fixture.index = index;
  return index;
}

/** Invoke the compiled public CLI exactly as an operator would. */
export function runPublishVerify(
  fixture: PublishDistribution,
  extraArgs: string[] = [],
  keyId = TAP_KEY.keyId,
  keyFile = fixture.keyFile,
): VerifyResult {
  const result = spawnSync(process.execPath, [
    CLI, "template", "publish", "verify", fixture.directory,
    "--key-id", keyId, "--key-file", keyFile, ...extraArgs,
  ], { cwd: fixture.root, encoding: "utf8", env: offlineEnvironment(fixture.root), timeout: CLI_TIMEOUT_MS });
  if (result.error) throw new Error(`publisher verifier subprocess failed: ${result.error.message}`);
  if (result.signal) throw new Error(`publisher verifier subprocess ended by ${result.signal}`);
  if (result.status === null) throw new Error("publisher verifier subprocess ended without an exit status");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Capture names, kinds, sizes, and content hashes without following symlinks. */
export async function snapshotTree(root: string): Promise<string[]> {
  return snapshotEntries(root, "");
}

/** Remove a temporary distribution and all adversarial entries beneath it. */
export async function removePublishDistribution(fixture: PublishDistribution): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

/** Return combined bounded CLI diagnostics for assertions. */
export function diagnostics(result: VerifyResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** Convert the protocol digest to its only permitted package filename. */
export function digestHex(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) throw new Error(`invalid fixture digest: ${digest}`);
  return match[1];
}

function currentIndex(envelope: SignedPackageEnvelope): SignedTapIndex {
  const coordinate = parseTemplateCoordinate(envelope.coordinate);
  const now = Date.now();
  return signedIndex({
    generatedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + DAY_MS).toISOString(),
    packages: [{
      coordinate: envelope.coordinate,
      publisher: coordinate.publisher,
      payloadDigest: envelope.payloadDigest,
    }],
  });
}

function offlineEnvironment(root: string): NodeJS.ProcessEnv {
  const guard = `--import=${pathToFileURL(path.join(root, "deny-network.mjs")).href}`;
  const environmentRoot = path.join(root, "environment");
  return {
    ...process.env,
    HOME: path.join(environmentRoot, "home"),
    APPDATA: path.join(environmentRoot, "config"),
    LOCALAPPDATA: path.join(environmentRoot, "cache"),
    XDG_CONFIG_HOME: path.join(environmentRoot, "config"),
    XDG_CACHE_HOME: path.join(environmentRoot, "cache"),
    XDG_DATA_HOME: path.join(environmentRoot, "data"),
    XDG_STATE_HOME: path.join(environmentRoot, "state"),
    TMPDIR: path.join(environmentRoot, "tmp"),
    TMP: path.join(environmentRoot, "tmp"),
    TEMP: path.join(environmentRoot, "tmp"),
    LLMWIKI_VERBOSE: "",
    FORCE_COLOR: "0",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
    NODE_OPTIONS: guard,
  };
}

function writableEnvironmentDirectories(root: string): string[] {
  const environmentRoot = path.join(root, "environment");
  return ["home", "config", "cache", "data", "state", "tmp"]
    .map((name) => path.join(environmentRoot, name));
}

function networkGuardSource(): string {
  return [
    'import net from "node:net";',
    'net.Socket.prototype.connect = function denyNetwork() {',
    '  throw new Error("offline verifier attempted network access");',
    '};',
  ].join("\n");
}

async function snapshotEntries(root: string, relative: string): Promise<string[]> {
  const absolute = path.join(root, relative);
  const names = await readdir(absolute);
  const result: string[] = [];
  for (const name of names.sort()) {
    const childRelative = path.join(relative, name);
    const child = path.join(root, childRelative);
    const info = await lstat(child);
    result.push(await snapshotEntry(child, childRelative, info));
    if (info.isDirectory()) result.push(...await snapshotEntries(root, childRelative));
  }
  return result;
}

async function snapshotEntry(
  absolute: string,
  relative: string,
  info: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  if (!info.isFile()) return `${relative}:${info.mode}:${info.size}`;
  const bytes = await readFile(absolute);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${relative}:${info.mode}:${info.size}:${digest}`;
}
