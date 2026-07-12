/**
 * @file src/commands/template-tap.ts
 * @description CLI handlers for explicit template-tap lifecycle and refresh.
 */
import { TextDecoder } from "node:util";
import { readCappedNoFollowBuffer } from "../utils/confined-read.js";
import * as output from "../utils/output.js";
import { addTap, listTaps, removeTap, type TapSummary } from "../profile/templates/taps/manage.js";
import { resolveTapPaths } from "../profile/templates/taps/paths.js";
import { refreshTap } from "../profile/templates/taps/refresh.js";

const MAX_KEY_FILE_BYTES = 16 * 1024;

/** Key-source options accepted by `template tap add`. */
export interface TapAddOptions { keyId: string; keyFile?: string; keyBase64?: string }
/** Output options shared by tap list and refresh. */
export interface TapOutputOptions { json?: boolean }

/** Add or exactly re-enable one explicitly keyed tap. */
export async function templateTapAddCommand(name: string, indexUrl: string, options: TapAddOptions): Promise<number> {
  const publicKey = await readKey(options);
  const summary = await addTap(resolveTapPaths(), { name, indexUrl, key: { keyId: options.keyId, publicKey } });
  output.status("+", output.success(`Configured template tap '${summary.name}'`));
  console.log(`origin: ${summary.origin}`);
  console.log(`key:    ${summary.keyId} (${summary.keyFingerprint})`);
  return 0;
}

/** List configured taps without exposing raw key material. */
export async function templateTapListCommand(options: TapOutputOptions): Promise<number> {
  const taps = await listTaps(resolveTapPaths());
  if (options.json) console.log(JSON.stringify(taps, null, 2));
  else printTaps(taps);
  return 0;
}

/** Disable a tap while retaining continuity and trust history. */
export async function templateTapRemoveCommand(name: string): Promise<number> {
  const tap = await removeTap(resolveTapPaths(), name);
  output.status("-", output.warn(`Disabled template tap '${tap.name}' (trust history retained)`));
  return 0;
}

/** Fetch and accept the next signed snapshot for one tap. */
export async function templateTapRefreshCommand(name: string, options: TapOutputOptions): Promise<number> {
  const result = await refreshTap(resolveTapPaths(), name);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else output.status("+", output.success(`Refreshed '${result.tap}' to sequence ${result.sequence} (${result.packages} packages)`));
  return 0;
}

async function readKey(options: TapAddOptions): Promise<string> {
  const source = selectedKeySource(options);
  return source.kind === "inline" ? source.value : readKeyFile(source.path);
}

function selectedKeySource(options: TapAddOptions): { kind: "inline"; value: string } | { kind: "file"; path: string } {
  const hasInline = options.keyBase64 !== undefined;
  const hasFile = options.keyFile !== undefined;
  if (hasInline === hasFile) throw new Error("tap add requires exactly one of --key-file or --key-base64");
  return hasInline ? { kind: "inline", value: options.keyBase64! } : { kind: "file", path: options.keyFile! };
}

async function readKeyFile(file: string): Promise<string> {
  const read = await readCappedNoFollowBuffer(file, MAX_KEY_FILE_BYTES);
  if (read.kind !== "ok") throw new Error("tap key file is unavailable");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(read.body).trim();
  } catch {
    throw new Error("tap key file is not valid UTF-8");
  }
}

function printTaps(taps: TapSummary[]): void {
  console.log("Tap          Enabled  Sequence  Origin");
  for (const tap of taps) console.log(`${tap.name.padEnd(12)} ${String(tap.enabled).padEnd(8)} ${String(tap.highestSequence).padEnd(9)} ${tap.origin}`);
}
