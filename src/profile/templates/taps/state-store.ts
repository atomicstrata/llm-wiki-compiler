/**
 * @file src/profile/templates/taps/state-store.ts
 * @description Confined, capped, atomic persistence for authoritative tap state.
 */
import { lstat } from "node:fs/promises";
import { atomicWrite } from "../../../utils/atomic-write.js";
import { readConfinedLeaf } from "../../../utils/confined-read.js";
import { parseTapOperatorState, MAX_TAP_STATE_BYTES } from "./state-parse.js";
import { emptyTapOperatorState, type TapOperatorState } from "./state-types.js";
import type { TapPaths } from "./paths.js";
import { ensurePrivateRoot } from "./private-root.js";

/** Read authoritative state; only a genuinely absent leaf means empty state. */
export async function readTapState(paths: TapPaths): Promise<TapOperatorState> {
  const exists = await lstat(paths.configRoot).catch((error) => absentOrThrow(error));
  if (exists === null) return emptyTapOperatorState();
  if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error("template tap config root is unavailable");
  const read = await readConfinedLeaf(paths.configRoot, paths.stateFile, paths.configRoot, MAX_TAP_STATE_BYTES);
  if (read.kind === "absent") return emptyTapOperatorState();
  if (read.kind !== "ok") throw new Error("template tap state is unavailable");
  return parseTapOperatorState(read.body);
}

/** Atomically replace authoritative state under a private confined root. */
export async function writeTapState(paths: TapPaths, state: TapOperatorState): Promise<void> {
  await ensurePrivateRoot(paths.configRoot);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  parseTapOperatorState(text);
  await atomicWrite(paths.stateFile, text, { confineRoot: paths.configRoot, durable: true, mode: 0o600 });
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
