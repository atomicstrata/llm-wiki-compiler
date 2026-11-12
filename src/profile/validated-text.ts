/**
 * Profile JSON text to a validated, digested profile pack, once per process per exact text.
 *
 * Every effective-profile load ends the same way: the legacy loader reads
 * `.llmwiki/profile.json`, the product binding reads the knowledge-profile member,
 * and each parses the text, runs the two-phase {@link validateProfile} (ajv schema
 * plus every semantic check) and takes {@link profileDigest}. One process loads the
 * same profile on every lock acquisition, command and check, so the same text was
 * parsed, validated and canonicalized again each time.
 *
 * That pipeline is a pure function of the text: it reads no file, no clock and no
 * root, and the schema and the semantic rules are this module's own code. So the
 * verdict on a text is remembered here through {@link verifiedTextMemo}:
 *   - the CALLER still reads the file from disk on every load, through its own
 *     confinement, and hands the text here — only the verdict is reused;
 *   - the key is the exact text, so a byte-different file (whitespace, key order)
 *     is validated afresh; the result carries no root or path, which each caller
 *     adds itself, so nothing leaks between projects;
 *   - a failure is never remembered: invalid JSON or an invalid profile throws on
 *     every call, with the same error, from the same code that threw it before;
 *   - every caller receives its own copy, so one caller's edit is never seen by
 *     another caller or by the memo.
 */

import { verifiedTextMemo } from "../utils/verified-bytes-memo.js";
import { profileDigest } from "./digest.js";
import type { ProfilePack } from "./types.js";
import { validateProfile } from "./validate.js";

/** A validated profile pack and its canonical digest. */
export interface ValidatedProfileText {
  profile: ProfilePack;
  digest: string;
}

/** The text was not JSON. Private: callers see only the error their `invalidJson` builds. */
class ProfileTextNotJsonError extends Error {
  constructor(readonly parseError: unknown) {
    super("profile text is not valid JSON");
  }
}

/** Parse, validate and digest one profile text. Pure in the text. */
function validateProfileText(text: string): ValidatedProfileText {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProfileTextNotJsonError(err);
  }
  const { profile } = validateProfile(parsed);
  return { profile, digest: profileDigest(profile) };
}

const validatedProfileMemo = verifiedTextMemo(validateProfileText);

/**
 * The validated profile and digest for `text`, as {@link validateProfile} and
 * {@link profileDigest} give them. Text that is not JSON throws the error
 * `invalidJson` builds from the raw `JSON.parse` error; a schema or semantic
 * violation throws the validator's own `ProfileValidationError`.
 */
export function validatedProfileText(text: string, invalidJson: (parseError: unknown) => Error): ValidatedProfileText {
  try {
    return validatedProfileMemo(text);
  } catch (err) {
    if (err instanceof ProfileTextNotJsonError) throw invalidJson(err.parseError);
    throw err;
  }
}
