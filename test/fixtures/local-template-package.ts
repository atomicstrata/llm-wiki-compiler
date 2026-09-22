/**
 * @file test/fixtures/local-template-package.ts
 * @description A TEST-OWNED profile template package, and the helper that writes
 * it where `installLocalTemplate` reads it.
 *
 * IT EXISTS BECAUSE CORE SHIPS NO INSTALLABLE BUILTIN ANY MORE. Every named
 * vocabulary is now product configuration behind `product install`, and the
 * registry carries only the implicit default (which is deliberately NOT
 * installable). The install/lock machinery those builtins used to exercise is
 * still core's own, so its tests drive it through the exported local-file path —
 * the same `installPackage` → `installPackageLocked` guards, reached the way a
 * user installing a hand-written template file reaches them.
 *
 * THE VOCABULARY IS DELIBERATELY TEST-ONLY. `gazette` is not a shipped product
 * and never will be: it exists so the machinery has a package to install without
 * a product instance living in core or a test depending on a package's bytes.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfilePack } from "../../src/profile/types.js";
import type { ProfileTemplatePackage } from "../../src/profile/templates/types.js";

/** The test-only profile this fixture's template installs. */
const gazetteProfile: ProfilePack = {
  schemaVersion: 1,
  profileId: "gazette",
  profileVersion: "0.1.0",
  displayName: "Gazette",
  entities: {
    columns: {
      directory: "wiki/columns",
      fields: {
        title: { type: "string", required: true },
        stage: { type: "enum", enum: ["drafting", "run"], required: true },
      },
      lifecycle: {
        field: "stage", initial: "drafting", terminal: ["run"],
        transitions: { drafting: ["run"] },
      },
    },
  },
};

/** The test-only template package the install machinery is driven with. */
export const GAZETTE_TEMPLATE: ProfileTemplatePackage = {
  schemaVersion: 1,
  templateId: "gazette",
  version: "0.1.0",
  displayName: "Gazette",
  publisher: "llmwiki-tests",
  sourceType: "local",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  description: "A test-only template package: one entity with a two-state lifecycle.",
  profile: gazetteProfile,
};

/** Write the template package JSON into `dir`; returns the file path. */
export async function writeLocalTemplateFile(dir: string, pkg: ProfileTemplatePackage = GAZETTE_TEMPLATE): Promise<string> {
  const filePath = path.join(dir, "template.json");
  await writeFile(filePath, JSON.stringify(pkg), "utf8");
  return filePath;
}
