/** Profile JSON text to a validated, digested profile pack, once per process per exact text. */

import { verifiedTextMemo } from "../utils/verified-bytes-memo.js";
import { profileDigest } from "./digest.js";
import type { ProfilePack } from "./types.js";
import { validateProfile } from "./validate.js";

/** A validated profile pack and its canonical digest. */
export interface ValidatedProfileText {
  profile: ProfilePack;
  digest: string;
}

class ProfileTextNotJsonError extends Error {
  constructor(readonly parseError: unknown) {
    super("profile text is not valid JSON");
  }
}

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

/** The validated profile and digest for `text`, as {@link validateProfile} and {@link profileDigest} give them. */
export function validatedProfileText(text: string, invalidJson: (parseError: unknown) => Error): ValidatedProfileText {
  try {
    return validatedProfileMemo(text);
  } catch (err) {
    if (err instanceof ProfileTextNotJsonError) throw invalidJson(err.parseError);
    throw err;
  }
}
