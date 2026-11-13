/**
 * @file The `--verbose` policy shared by commands that print detailed progress.
 */

import { ENV_VERBOSE } from "@atomicstrata/llmwiki-core/modules/utils/constants";

/**
 * Returns true when the --verbose flag was passed or LLMWIKI_VERBOSE is set
 * to a non-empty value in the environment. Both paths call setVerbose(true)
 * at the start of the action so verbose() emits output for that run only.
 */
export function verboseEnabled(flag?: boolean): boolean {
  return Boolean(flag) || Boolean(process.env[ENV_VERBOSE]?.trim());
}
