/**
 * The ONE artifact body validator, shared by the write plan (src/artifacts/plan.ts)
 * and read resolution (src/artifacts/resolve.ts) so the write-side and read-side
 * contracts can never drift: bytes valid when written MUST verify on read. Pure,
 * no I/O, PATH-FREE violation messages (empty = valid).
 */
import type { ArtifactTypeDef } from "../profile/types.js";
import { validateFieldsAgainstDefs } from "../profile/field-contract.js";

/** Violations of `def`'s body contract for `body`. */
export function validateArtifactBody(def: ArtifactTypeDef, body: string): string[] {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > def.maxBytes) return [`body is ${bytes} bytes; artifact maxBytes is ${def.maxBytes}`];
  if (def.contentKind !== "json") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return ["body is not valid JSON"]; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return ["json body must be a top-level non-array object"];
  }
  const metadata = def.metadata ?? {};
  const required = Object.entries(metadata).filter(([, d]) => d.required).map(([name]) => name);
  return validateFieldsAgainstDefs(parsed as Record<string, unknown>, metadata, required,
    (name) => `Required metadata field ${JSON.stringify(name)} is missing.`);
}
