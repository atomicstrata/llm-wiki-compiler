/** Byte-level source witnesses for tests proving product configuration cannot edit core. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Hash sorted source paths and raw bytes with unambiguous length framing. */
export function coreTreeFingerprint(includeUntracked = false): string {
  const selection = includeUntracked ? ["--cached", "--others", "--exclude-standard"] : [];
  const listed = execFileSync("git", ["ls-files", ...selection, "-z", "src"], { cwd: REPO_ROOT });
  const files = [...new Set(listed.toString("utf8").split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const bytes = readFileSync(path.join(REPO_ROOT, rel));
    hash.update(`${rel.length}:${rel}\n${bytes.length}:`);
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}
