/**
 * @file src/commands/template-publish.ts
 * @description Stable CLI presentation for read-only offline verification of
 * a signed template publisher distribution snapshot.
 */
import { initWorkspace, type InitWorkspaceOptions, type InitWorkspaceResult } from "../profile/templates/publish/init.js";
import { verifyPublisherDistribution } from "../profile/templates/publish/verify.js";

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const MAX_ERROR_MESSAGE_BYTES = 3_800;

/** Options required by `template publish verify`. */
export interface TemplatePublishVerifyOptions {
  tap: string;
  keyId: string;
  keyFile: string;
  json?: boolean;
}

/** Verify without network or writes, then print bounded public provenance only. */
export async function templatePublishVerifyCommand(
  directory: string,
  options: TemplatePublishVerifyOptions,
): Promise<number> {
  try {
    const result = await verifyPublisherDistribution(directory, options.tap, options.keyId, options.keyFile);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHumanResult(result);
    return 0;
  } catch (error) {
    throw new Error(boundedSafeError(error));
  }
}

function printHumanResult(result: Awaited<ReturnType<typeof verifyPublisherDistribution>>): void {
  console.log("Verified template publisher distribution.");
  console.log(`Scope: ${result.scope}`);
  console.log(`Continuity: ${result.continuity}`);
  console.log(`Tap: ${safeTerminalText(result.tap)}`);
  console.log(`Sequence: ${result.sequence}`);
  console.log(`Tap key: ${safeTerminalText(result.tapKeyId)}`);
  console.log(`Packages: ${result.packageCount}`);
}

function safeTerminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL, "�");
}

function boundedSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe = safeTerminalText(message || "publisher distribution verification failed");
  const bytes = Buffer.from(safe, "utf8");
  if (bytes.length <= MAX_ERROR_MESSAGE_BYTES) return safe;
  return `${bytes.subarray(0, MAX_ERROR_MESSAGE_BYTES - 3).toString("utf8").replace(/�$/u, "")}…`;
}

/** Options required by `template publish init`. */
export interface TemplatePublishInitOptions {
  tap: string;
  publisher: string;
  tapKeyId?: string;
  publisherKeyId?: string;
  json?: boolean;
}

/** Create a publisher workspace with fresh tap and publisher keypairs. */
export async function templatePublishInitCommand(
  directory: string,
  options: TemplatePublishInitOptions,
): Promise<number> {
  try {
    const result = await initWorkspace(directory, initOptions(options));
    if (options.json) console.log(JSON.stringify(publicInitResult(result), null, 2));
    else printInitResult(result);
    return 0;
  } catch (error) {
    throw new Error(boundedSafeError(error));
  }
}

/** Forward only the key-id overrides the operator actually supplied. */
function initOptions(options: TemplatePublishInitOptions): InitWorkspaceOptions {
  return {
    tap: options.tap,
    publisher: options.publisher,
    ...(options.tapKeyId === undefined ? {} : { tapKeyId: options.tapKeyId }),
    ...(options.publisherKeyId === undefined ? {} : { publisherKeyId: options.publisherKeyId }),
  };
}

/** The public shape: key ids and fingerprints only, never private bytes. */
function publicInitResult(result: InitWorkspaceResult): object {
  return {
    schemaVersion: 1,
    tap: result.tap,
    publisher: result.publisher,
    tapKeyId: result.tapKey.keyId,
    publisherKeyId: result.publisherKey.keyId,
    fingerprints: result.fingerprints,
  };
}

function printInitResult(result: InitWorkspaceResult): void {
  console.log("Initialized publisher workspace.");
  console.log(`Tap: ${safeTerminalText(result.tap)}`);
  console.log(`Publisher: ${safeTerminalText(result.publisher)}`);
  console.log(`Tap key: ${safeTerminalText(result.tapKey.keyId)} (${result.fingerprints.tap})`);
  console.log(`Publisher key: ${safeTerminalText(result.publisherKey.keyId)} (${result.fingerprints.publisher})`);
  console.log("Private keys are stored 0600 under keys/ and are never printed.");
  console.log("Distribute the tap public key through a channel independent of the tap.");
}
