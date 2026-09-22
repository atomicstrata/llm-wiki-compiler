/**
 * @file src/connectors/candidate-display.ts
 * @description Bounded reversible terminal presentation for exact candidate
 * identities. SDK results and events retain the original validated string;
 * only the CLI quotes exotic identities and escapes line/control, format/bidi,
 * surrogate, quoting, and list-delimiter code units so one candidate cannot
 * forge physical lines or visually merge with an adjacent list item.
 */

import {
  captureConnectorCandidateIds,
  captureConnectorReason,
} from "./candidate-batch.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";

/** Ordinary generated candidate identities preserve their historical display. */
const ORDINARY_CANDIDATE_ID = /^[A-Za-z0-9._-]+$/;

/** Unicode format controls include bidi and zero-width presentation controls. */
const UNICODE_FORMAT_CONTROL = /\p{Cf}/u;

/** Individual syntax and line-separator code units escaped in quoted output. */
const UNSAFE_LITERAL_UNITS = new Set([0x22, 0x2c, 0x5c, 0x2028, 0x2029]);

/** Return one fixed lower-case four-hex UTF-16 escape. */
function escapeCodeUnit(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

/** True for C0/C1 controls that can alter terminal presentation. */
function isTerminalControl(codeUnit: number): boolean {
  return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f);
}

/** True for a UTF-16 surrogate code unit that cannot stand alone safely. */
function isSurrogateUnit(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

/** True when one BMP code unit must never be emitted raw to the terminal. */
function isUnsafeBmpUnit(codeUnit: number, character: string): boolean {
  if (isTerminalControl(codeUnit) || isSurrogateUnit(codeUnit)) return true;
  return UNSAFE_LITERAL_UNITS.has(codeUnit) || UNICODE_FORMAT_CONTROL.test(character);
}

/** Escape one quoted identity without normalization, repair, or truncation. */
function escapeTerminalText(value: string): string {
  let rendered = "";
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    const point = value.codePointAt(index)!;
    const width = point > 0xffff ? 2 : 1;
    const character = value.slice(index, index + width);
    if (width === 2) {
      rendered += escapeCodeUnit(first) + escapeCodeUnit(value.charCodeAt(index + 1));
    } else if (isUnsafeBmpUnit(first, character)) {
      rendered += escapeCodeUnit(first);
    } else {
      rendered += character;
    }
    index += width - 1;
  }
  return rendered;
}

/** Render one exact candidate identity as a reversible one-line value. */
function renderCandidateId(candidateId: string): string {
  if (ORDINARY_CANDIDATE_ID.test(candidateId)) return candidateId;
  return `"${escapeTerminalText(candidateId)}"`;
}

/** Render one exact accepted result reason as bounded one-line terminal data. */
export function renderConnectorReason(reason: string): string {
  return escapeTerminalText(captureConnectorReason(reason));
}

/** Render one already-validated bounded candidate list without truncation. */
export function renderCandidateIds(
  candidateIds: readonly string[], policy: CandidateCustodyPolicy = "bounded",
): string {
  const captured = captureConnectorCandidateIds(candidateIds, policy);
  let rendered = "";
  for (let index = 0; index < captured.length; index += 1) {
    if (index > 0) rendered += ", ";
    rendered += renderCandidateId(captured[index]!);
  }
  return rendered;
}
