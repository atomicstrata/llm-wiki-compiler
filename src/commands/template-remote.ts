/**
 * @file src/commands/template-remote.ts
 * @description Read-only CLI handlers for signed remote template discovery.
 */
import * as output from "../utils/output.js";
import { inspectRemoteTemplate, searchRemoteTemplates } from "../profile/templates/taps/discovery.js";
import { resolveTapPaths } from "../profile/templates/taps/paths.js";

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** Options accepted by remote search. */
export interface TemplateSearchOptions { tap?: string; json?: boolean }
/** Stable-output option shared by remote inspect and verify. */
export interface RemoteOutputOptions { json?: boolean }

/** Search accepted signed indexes without downloading package bodies. */
export async function templateSearchCommand(query: string, options: TemplateSearchOptions): Promise<number> {
  const search = await searchRemoteTemplates(resolveTapPaths(), query, options.tap);
  if (options.json) console.log(JSON.stringify(search, null, 2));
  else printSearch(search);
  return 0;
}

/** Inspect one fully verified qualified remote template. */
export async function templateRemoteInspectCommand(coordinate: string, options: RemoteOutputOptions): Promise<number> {
  const details = await inspectRemoteTemplate(resolveTapPaths(), coordinate);
  if (options.json) console.log(JSON.stringify(details, null, 2));
  else printDetails(details);
  return 0;
}

/** Verify one package and print only its bounded public provenance. */
export async function templateVerifyCommand(coordinate: string, options: RemoteOutputOptions): Promise<number> {
  const details = await inspectRemoteTemplate(resolveTapPaths(), coordinate);
  const result = {
    coordinate: details.coordinate,
    verified: true,
    payloadDigest: details.payloadDigest,
    publisherKeyId: details.publisherKeyId,
    tapSequence: details.sequence,
    stale: details.stale,
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else output.status("+", output.success(`Verified ${coordinate} at tap sequence ${details.sequence}`));
  return 0;
}

function printDetails(details: Awaited<ReturnType<typeof inspectRemoteTemplate>>): void {
  output.header(`Remote template ${details.coordinate}`);
  console.log(`display:     ${terminalMetadata(details.displayName)}`);
  console.log(`license:     ${terminalMetadata(details.license)}`);
  console.log(`digest:      ${details.payloadDigest}`);
  console.log(`publisherKey:${details.publisherKeyId}`);
  console.log(`tapSequence: ${details.sequence}`);
  console.log(`status:      ${details.stale ? "stale accepted evidence" : "current"}`);
}

function terminalMetadata(value: string): string {
  return value.replace(TERMINAL_CONTROL, "�");
}

function printSearch(search: Awaited<ReturnType<typeof searchRemoteTemplates>>): void {
  console.log("Coordinate                                      Sequence  Status");
  for (const item of search.results) {
    console.log(`${item.coordinate.padEnd(47)} ${String(item.sequence).padEnd(9)} ${item.stale ? "stale" : "current"}`);
  }
  for (const warning of search.warnings) output.note(`Warning: tap '${warning.tap}' skipped: ${warning.reason}`);
}
