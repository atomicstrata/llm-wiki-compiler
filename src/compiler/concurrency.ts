/**
 * Compile concurrency resolution for the llmwiki pipeline.
 *
 * One knob — the `--concurrency` flag or the LLMWIKI_COMPILE_CONCURRENCY env
 * var — caps how many LLM calls run in parallel during a compile, across both
 * phase 1 (concept extraction) and phase 2 (page generation). Raising it cuts
 * wall-clock on cold starts and large refreshes; lowering it eases provider
 * rate-limit pressure. The explicit flag wins over the env var, which wins over
 * the built-in default. Mirrors resolveEmbedBatchSize's parse-validate-clamp
 * shape so the two compile-time knobs behave consistently.
 */

import {
  COMPILE_CONCURRENCY,
  COMPILE_CONCURRENCY_MAX,
  ENV_COMPILE_CONCURRENCY,
} from "../utils/constants.js";
import * as output from "../utils/output.js";

/** Source of a concurrency override, used only for warning messages. */
interface OverrideSource {
  raw: string | undefined;
  label: string;
}

/** Pick the highest-precedence override: explicit flag, then env var. */
function pickOverride(override: number | undefined): OverrideSource {
  if (override !== undefined) return { raw: String(override), label: "--concurrency" };
  return { raw: process.env[ENV_COMPILE_CONCURRENCY]?.trim(), label: ENV_COMPILE_CONCURRENCY };
}

/**
 * Resolve the effective compile concurrency.
 * @param override - Value from the `--concurrency` flag, if provided.
 * @returns A positive integer in [1, COMPILE_CONCURRENCY_MAX]; the default on
 *          an unset or invalid value, clamped when the request exceeds the cap.
 */
export function resolveCompileConcurrency(override?: number): number {
  const { raw, label } = pickOverride(override);
  if (!raw) return COMPILE_CONCURRENCY;

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    output.status("!", output.warn(
      `${label} value "${raw}" is not a positive integer; using ${COMPILE_CONCURRENCY}.`,
    ));
    return COMPILE_CONCURRENCY;
  }
  if (n > COMPILE_CONCURRENCY_MAX) {
    output.status("!", output.warn(
      `${label} ${n} exceeds the max of ${COMPILE_CONCURRENCY_MAX}; clamping to ${COMPILE_CONCURRENCY_MAX}.`,
    ));
    return COMPILE_CONCURRENCY_MAX;
  }
  return n;
}
