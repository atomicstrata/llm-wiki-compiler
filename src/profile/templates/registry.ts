/**
 * @file src/profile/templates/registry.ts
 * @description Static registry for builtin install-time profile templates.
 */
import { deriveTemplateCapabilities } from "./capabilities.js";
import type { ProfileTemplatePackage, ProfileTemplateSummary } from "./types.js";
import { AUTOSCI_TEMPLATE } from "./builtin/autosci.js";
import { DEFAULT_TEMPLATE_SUMMARY } from "./builtin/default.js";
import { NEWSROOM_TEMPLATE } from "./builtin/newsroom.js";

const BUILTIN_TEMPLATES: readonly ProfileTemplatePackage[] = [
  AUTOSCI_TEMPLATE,
  NEWSROOM_TEMPLATE,
];

/** List inspectable builtin template summaries. */
export function listBuiltinTemplates(): readonly ProfileTemplateSummary[] {
  return [
    DEFAULT_TEMPLATE_SUMMARY,
    ...BUILTIN_TEMPLATES.map(summaryFor),
  ];
}

/** Resolve an installable builtin template by id. `default` is intentionally absent. */
export function getBuiltinTemplate(id: string): ProfileTemplatePackage | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.templateId === id);
}

/** Build one user-facing summary from a package. */
export function summaryFor(template: ProfileTemplatePackage): ProfileTemplateSummary {
  return {
    templateId: template.templateId,
    profileId: template.profile.profileId,
    displayName: template.displayName,
    version: template.version,
    publisher: template.publisher,
    sourceType: template.sourceType,
    installable: true,
    capabilities: deriveTemplateCapabilities(template.profile),
  };
}
