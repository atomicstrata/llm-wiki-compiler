#!/usr/bin/env node
/**
 * @file scripts/refuse-direct-publish.mjs
 * @description `prepublishOnly` of every public package in this repository:
 * it always refuses. A package published straight from the source tree would
 * carry whatever the working tree and its build happened to hold. The one
 * reviewed release path stages the packages from the checked composition
 * (`node scripts/build-public-release.mjs`), verifies the stage and its real
 * tarballs against this exact source (`node scripts/check-public-boundary.mjs`),
 * and publishes only from `.public-release/stage/<package>` after a separate,
 * explicit approval. This script publishes nothing and grants no approval.
 */

console.error([
  "Refusing to publish from the source tree.",
  "A release is published only from the checked stage:",
  "  1. Stage:   node scripts/build-public-release.mjs",
  "  2. Verify:  node scripts/check-public-boundary.mjs   (every check and the release readiness must pass)",
  "  3. Publish: only from .public-release/stage/<package>, after explicit approval.",
  "See CONTRIBUTING.md, \"Releasing\".",
].join("\n"));
process.exitCode = 1;
