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
 * The entity block exactly as `0.1.0` published it: `0.2.0` minus the title
 * declarations, which are the only difference between the two releases.
 *
 * Derived rather than frozen as a second 190-line copy. The derivation is not
 * cosmetic — `planTemplateUpdate` compares this package's `profileDigest`
 * against the INSTALLED on-disk profile to decide whether a project has local
 * modifications, so a retained `0.1.0` that carried `titleField` would report
 * every genuine `0.1.0` install as locally modified. `test/profile-template-registry.test.ts`
 * pins the resulting digest to the literal `0.1.0` published, so a later edit to
 * the `0.2.0` entities that would corrupt this fails loudly instead of silently
 * mis-describing an installed project.
 */
function entitiesWithoutTitleFields(): ProfilePack["entities"] {
  return Object.fromEntries(
    Object.entries(autosciEntities).map(([type, def]) => {
      const { titleField: _dropped, ...rest } = def;
      return [type, rest];
    }),
  ) as ProfilePack["entities"];
}

/**
 * The superseded `0.1.0` release, retained so secure update planning can resolve
 * the EXACT installed release rather than reinterpreting it as the newest
 * package sharing its template id. Without it, `planBuiltinTemplateUpdate`
 * throws for every project still on `0.1.0`.
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
  profile: { ...profile, profileVersion: "0.1.0", entities: entitiesWithoutTitleFields() },
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
