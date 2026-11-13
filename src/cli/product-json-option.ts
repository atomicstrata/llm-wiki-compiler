/**
 * @file src/cli/product-json-option.ts
 * @description The `--json` description every `product` verb shares. Every
 * verb answers `--json` with the same envelope contract, so the flag is
 * described once for all of the group's configuration modules.
 */

/** Every verb here answers `--json` with the same envelope contract. */
export const JSON_DESCRIPTION = "Emit the machine-readable envelope instead of the human lines";
