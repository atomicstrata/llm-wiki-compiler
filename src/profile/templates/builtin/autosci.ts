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
import { withoutTitleFields } from "../title-fields.js";

const profile: ProfilePack = {
  schemaVersion: 1,
  profileId: "autosci",
  profileVersion: "0.2.0",
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

/**
 * The superseded `0.1.0` release, retained so secure update planning can resolve
 * the EXACT installed release rather than reinterpreting it as the newest
 * package sharing its template id. Without it, `planBuiltinTemplateUpdate`
 * throws for every project still on `0.1.0`. Its entity block is `0.2.0` minus
 * the title declarations — see {@link withoutTitleFields}.
 */
const AUTOSCI_TEMPLATE_0_1_0: ProfileTemplatePackage = {
  schemaVersion: 1,
  templateId: "autosci",
  version: "0.1.0",
  displayName: "AutoSci",
  publisher: "atomicstrata",
  sourceType: "builtin",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  description:
    "AutoSci-style research profile with papers, ideas, experiments, manuscripts, artifacts, workflows, and Crossref import.",
  profile: { ...profile, profileVersion: "0.1.0", entities: withoutTitleFields(autosciEntities) },
};

/** Every published AutoSci release, newest last. */
export const AUTOSCI_TEMPLATE_RELEASES: readonly ProfileTemplatePackage[] = [AUTOSCI_TEMPLATE_0_1_0];

/** Builtin install package for AutoSci-derived research projects. */
export const AUTOSCI_TEMPLATE: ProfileTemplatePackage = {
  schemaVersion: 1,
  templateId: "autosci",
  version: "0.2.0",
  displayName: "AutoSci",
  publisher: "atomicstrata",
  sourceType: "builtin",
  license: "MIT",
  minLlmwikiVersion: "1.0.0",
  description: "AutoSci-style research profile with papers, ideas, experiments, manuscripts, artifacts, workflows, and Crossref import.",
  profile,
};
