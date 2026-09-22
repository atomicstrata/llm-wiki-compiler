/**
 * @file src/trust/journal-prestate.ts
 * @description Pre-state ENCODING and BUDGET rules for the intent journal
 * (`./journal.ts`) — the representation half of the journal's contract, split
 * out so the batch/replay mechanics and the byte-level rules evolve separately.
 *
 * ENCODING: a recorded pre-state carries its bytes as a string. The legacy (and
 * still default) representation is the raw UTF-8 text — every journal written
 * before the discriminant existed parses and replays byte-identically. Binary
 * targets are recorded with `encoding: "base64"` ALWAYS — one invariant, no
 * content sniffing — because a binary pre-state routed through a UTF-8 string
 * round-trip would be silently corrupted and a crash-revert would then restore
 * corrupt bytes over a file that was intact before the batch.
 *
 * STRICTNESS: base64 content is accepted only in CANONICAL form (standard
 * alphabet, correct padding, no whitespace, no non-canonical trailing bits). A
 * journal entry whose base64 does not round-trip is refused rather than
 * permissively decoded — replay must restore exactly the recorded bytes or
 * nothing.
 *
 * BUDGET: a batch's recorded pre-states are bounded in AGGREGATE, measured in
 * DECODED bytes (the real payload a rollback would restore — the same quantity
 * for a text and a binary entry), never the persisted base64/JSON envelope.
 */

/** How a recorded pre-state's `content` string encodes the target's bytes. */
export type PreStateEncoding = "utf8" | "base64";

/** A present target's recorded pre-state. Absent `encoding` means UTF-8 (legacy). */
export interface RecordedPreState {
  absent: false;
  content: string;
  encoding?: PreStateEncoding;
}

/**
 * Thrown when recording one more pre-state would push a batch's aggregate
 * DECODED pre-state bytes over its budget. The mutation is refused BEFORE the
 * entry is appended or persisted, so the journal on disk never grows past the
 * budget and the batch remains consistently replayable.
 */
export class JournalAggregateBudgetExceededError extends Error {
  constructor(readonly targetPath: string, wouldBe: number, budget: number) {
    super(
      `journal pre-state for ${JSON.stringify(targetPath)} would put the batch at ` +
        `${wouldBe} aggregate decoded bytes, over its ${budget}-byte budget — refusing the mutation`,
    );
    this.name = "JournalAggregateBudgetExceededError";
  }
}

/**
 * True only for CANONICAL base64: exact decode→re-encode equality refuses
 * whitespace, foreign alphabets, bad padding and non-canonical trailing bits.
 * Avoid repeated-group regular expressions: valid multi-megabyte journal
 * entries can exhaust their backtracking stack before recovery begins.
 */
export function isCanonicalBase64(content: string): boolean {
  return Buffer.from(content, "base64").toString("base64") === content;
}

/** Encode raw target bytes as a base64-ALWAYS recorded pre-state. */
export function binaryPreState(bytes: Uint8Array): RecordedPreState {
  return { absent: false, content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
}

/**
 * The DECODED byte count one pre-state contributes to its batch's aggregate
 * budget: the bytes a rollback would restore (0 for an absent marker). Base64
 * entries count their decoded length, not the ~4/3× envelope, so the budget
 * means the same thing for text and binary entries.
 */
export function preStateDecodedByteCount(preState: { absent: true } | RecordedPreState): number {
  if (preState.absent) return 0;
  if (preState.encoding === "base64") return Buffer.from(preState.content, "base64").length;
  return Buffer.byteLength(preState.content, "utf8");
}

/**
 * The exact content a revert must write for a recorded pre-state: the raw
 * string for a UTF-8 (legacy) entry — byte-identical to today's behavior — or
 * the decoded Buffer for a base64 entry. Returns null for non-canonical
 * base64, which the caller must treat as an unreadable pre-state (fail
 * closed), never decode permissively.
 */
export function preStateRestoreContent(preState: RecordedPreState): string | Buffer | null {
  if (preState.encoding === undefined || preState.encoding === "utf8") return preState.content;
  if (!isCanonicalBase64(preState.content)) return null;
  return Buffer.from(preState.content, "base64");
}
