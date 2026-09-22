/** The common path policy for sealing and re-verifying retained source leaves. */

/** Reject separators, hidden names and dot segments before confined reading. */
export function isFlatSourceLeaf(relative: string): boolean {
  return relative.length > 0 && !relative.includes("/") && !relative.includes("\\")
    && relative !== "." && relative !== ".." && !relative.startsWith(".");
}
