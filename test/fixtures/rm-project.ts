/**
 * @file test/fixtures/rm-project.ts
 * @description Shared temp-project scaffolding for the `llmwiki rm` test
 * suites (`test/rm-integration.test.ts`, `test/commands/rm-cli.test.ts`).
 *
 * Both suites need an on-disk project with the exact shape `rm` reads and
 * writes — `sources/`, `wiki/concepts/`, `.llmwiki/state.json` — including a
 * two-source case where one source exclusively owns a page and co-owns
 * another with a live source. Hand-rolling that per file is exactly the
 * duplication fallow's clone detector flags (both suites had drifted into
 * near-identical copies), so it is defined once here instead.
 *
 * {@link twoSourceRmProjectWithProfile} adds the P1-audit-fix shape: the same
 * two-source project, PLUS a non-default profile, so both suites can pin that
 * `rm` still works there (deletes/keeps concepts exactly as the default case)
 * while `planRemoval`'s plan carries the profile's id for the CLI to warn with.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WikiState } from "../../src/utils/types.js";
import { writeProfileFile, SAMPLE_PROFILE } from "./profile-fixtures.js";

/**
 * Create an empty temp project root with the directories `rm` touches:
 * `sources/`, `wiki/concepts/`, `.llmwiki/`. Callers seed files into it.
 *
 * @returns Absolute path to the created temporary root.
 */
export async function makeEmptyRmProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rm-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  return root;
}

/**
 * A project where `bad.md` exclusively owns `junk` and co-owns `shared` with
 * `good.md` — the shape both rm suites need to distinguish a real delete from
 * a real keep. `shared.md`'s body links to `[[Junk]]` so the integration
 * suite can also pin the broken-wikilink report; that link is inert for
 * suites that don't check it.
 *
 * @returns Absolute path to the created temporary root.
 */
export async function twoSourceRmProject(): Promise<string> {
  const root = await makeEmptyRmProject();
  for (const name of ["bad", "good"]) {
    await writeFile(path.join(root, `sources/${name}.md`), `---\ntitle: ${name}\nsource: ${name}\n---\nbody`, "utf-8");
  }
  await writeFile(path.join(root, "wiki/concepts/junk.md"), "---\ntitle: Junk\n---\njunk body", "utf-8");
  await writeFile(path.join(root, "wiki/concepts/shared.md"), "---\ntitle: Shared\n---\nsee [[Junk]]", "utf-8");
  const state: WikiState = {
    version: 1,
    indexHash: "h",
    sources: {
      "bad.md": { hash: "a", concepts: ["junk", "shared"], compiledAt: "2026-01-01T00:00:00Z" },
      "good.md": { hash: "b", concepts: ["shared"], compiledAt: "2026-01-01T00:00:00Z" },
    },
  };
  await writeFile(path.join(root, ".llmwiki/state.json"), JSON.stringify(state), "utf-8");
  return root;
}

/**
 * {@link twoSourceRmProject}, plus a NON-DEFAULT profile ({@link SAMPLE_PROFILE},
 * `profileId: "sample"`) installed at `.llmwiki/profile.json`. `SAMPLE_PROFILE`
 * declares only a `notes` entity type at `wiki/notes`, so `wiki/concepts/`
 * stays free — matching the audit's premise that a profile project can still
 * legitimately hold concept pages `rm` must go on deleting normally.
 *
 * @returns Absolute path to the created temporary root.
 */
export async function twoSourceRmProjectWithProfile(): Promise<string> {
  const root = await twoSourceRmProject();
  await writeProfileFile(root, SAMPLE_PROFILE);
  return root;
}
