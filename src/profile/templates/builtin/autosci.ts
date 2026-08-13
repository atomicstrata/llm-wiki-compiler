/**
 * @file src/profile/templates/builtin/autosci.ts
 * @description Builtin install-time package for the AutoSci profile template.
 */
import type { ProfilePack } from "../../types.js";
import type { ProfileTemplatePackage } from "../types.js";
import { autosciArtifacts } from "./autosci/artifacts.js";
import { autosciEntities } from "./autosci/entities.js";
import { autosciRelations } from "./autosci/relations.js";
import { autosciWorkflowActions, autosciWorkflows } from "./autosci/workflows.js";
import { withoutFieldFormats, withoutTitleFields } from "../prior-releases.js";

const profile: ProfilePack = {
  schemaVersion: 1,
  profileId: "autosci",
  profileVersion: "0.3.0",
  displayName: "AutoSci",
  entities: autosciEntities,
  relations: autosciRelations,
  artifacts: autosciArtifacts,
  connectors: {
    crossref: {
      entityType: "papers",
      fields: { title: "title", doi: "doi", year: "year", authors: "authors", stage: "stage" },
      contentField: "abstract",
    },
  },
  workflows: autosciWorkflows,
  workflowActions: autosciWorkflowActions,
};

const DESCRIPTION =
  "AutoSci-style research profile with papers, ideas, experiments, manuscripts, artifacts, workflows, and Crossref import.";

/** One superseded AutoSci release, built from the current pack's shared envelope. */
function priorRelease(version: string, entities: ProfilePack["entities"]): ProfileTemplatePackage {
  return {
    schemaVersion: 1,
    templateId: "autosci",
    version,
    displayName: "AutoSci",
    publisher: "atomicstrata",
    sourceType: "builtin",
    license: "MIT",
    minLlmwikiVersion: "1.0.0",
    description: DESCRIPTION,
    profile: { ...profile, profileVersion: version, entities },
  };
}

/**
 * Every superseded release, retained so secure update planning can resolve the
 * EXACT installed release rather than reinterpreting it as the newest package
 * sharing its template id. Without them, `planBuiltinTemplateUpdate` throws for
 * every project still on one.
 *
 * Each entity block is DERIVED from the current one by undoing exactly the
 * change that release did not have, and the derivations compose backwards:
 * `0.2.0` is `0.3.0` without the field formats, and `0.1.0` is that without the
 * title declarations. Each published digest is pinned in
 * `test/profile-template-releases.test.ts`, so a later edit that corrupts
 * a derivation fails there rather than silently mis-describing an installed
 * project. See {@link withoutFieldFormats}.
 */
const AUTOSCI_0_2_0_ENTITIES = withoutFieldFormats(autosciEntities);

export const AUTOSCI_TEMPLATE_RELEASES: readonly ProfileTemplatePackage[] = [
  priorRelease("0.1.0", withoutTitleFields(AUTOSCI_0_2_0_ENTITIES)),
  priorRelease("0.2.0", AUTOSCI_0_2_0_ENTITIES),
];

/** Builtin install package for AutoSci-derived research projects. */
export const AUTOSCI_TEMPLATE: ProfileTemplatePackage = {
  schemaVersion: 1,
  templateId: "autosci",
  version: "0.3.0",
  displayName: "AutoSci",
  publisher: "atomicstrata",
  sourceType: "builtin",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  description: DESCRIPTION,
  profile,
};
