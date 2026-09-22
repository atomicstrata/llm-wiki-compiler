/**
 * @file src/commands/preparation/documents.ts
 * @description Turning the operator's file arguments into the documents the
 * preparation service asks for.
 *
 * THE ONLY PLACE THE PREPARATION CLI TOUCHES THE FILESYSTEM, and it knows
 * nothing about preparations: it imports the service's document TYPE and no
 * behaviour at all. That split is what the adapter boundary control asserts —
 * a module that can open a path may not also invoke a preparation operation, so
 * "reach the store from an adapter" has no module to live in.
 *
 * Paths are the CLI's own transport input: the operator names them on the
 * command line, relative to their shell's directory. Neither the service nor any
 * other surface ever sees one.
 */

import { readFile } from "node:fs/promises";
import type { PreparationDocumentV1 } from "../../preparations/service.js";

/**
 * Read one operator-named document, or say why it could not be read.
 *
 * @param label - How the refusal names this document to the operator.
 * @param file - The path the operator supplied.
 * @returns The document text, or a refusal naming the label and the path.
 */
export async function readOperatorDocument(
  label: "plan" | "seed", file: string,
): Promise<PreparationDocumentV1> {
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null
    ? { ok: false, reason: `${label} file is unreadable: ${file}` }
    : { ok: true, text };
}

/**
 * The seed document, including the case where the operator named no file.
 *
 * "this plan declares" implied a per-plan property, but EVERY valid plan
 * declares an initial input set — the schema requires it — so the refusal has
 * to name the flag the operator needs rather than fail deeper on evidence
 * coverage.
 */
export async function readSeedDocument(file: string | undefined): Promise<PreparationDocumentV1> {
  return file === undefined
    ? {
      ok: false,
      reason: "every plan declares an initial input set; pass --seed <file> with the bytes it hashes to",
    }
    : readOperatorDocument("seed", file);
}
