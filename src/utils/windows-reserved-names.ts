/**
 * @file src/utils/windows-reserved-names.ts
 * @description The canonical list of Windows reserved device names (con, prn,
 * aux, nul, com1-9, lpt1-9). These names cannot be used as a path segment on
 * Windows, so any identity that becomes an on-disk path component must reject
 * them. Shared by every surface that validates such identities so the list is
 * defined exactly once.
 */

/** Windows reserved device names, rejected wherever an identity becomes a path segment. */
export const WINDOWS_RESERVED_DEVICE_NAMES: readonly string[] = [
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
];
