/**
 * @file src/commands/template-publish.ts
 * @description Stable CLI presentation for read-only offline verification of
 * a signed template publisher distribution snapshot.
 */
import { verifyPublisherDistribution } from "../profile/templates/publish/verify.js";

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const MAX_ERROR_MESSAGE_BYTES = 3_800;

/** Options required by `template publish verify`. */
export interface TemplatePublishVerifyOptions {
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
    const result = await verifyPublisherDistribution(directory, options.keyId, options.keyFile);
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
