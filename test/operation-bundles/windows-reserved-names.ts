/**
 * @file test/operation-bundles/windows-reserved-names.ts
 * @description Re-exports the canonical Windows reserved device-name list from
 * the shared source module so the operation-identity tests assert against the
 * exact set the production code rejects, defined in exactly one place.
 */

export { WINDOWS_RESERVED_DEVICE_NAMES } from "../../src/utils/windows-reserved-names.js";
