/**
 * @file src/profile/templates/builtin/default.ts
 * @description Inspect-only template summary for the implicit built-in default
 * profile.
 */
import { DEFAULT_PROFILE } from "../../default.js";
import { deriveTemplateCapabilities } from "../capabilities.js";
import type { ProfileTemplateSummary } from "../types.js";

/** Summary for the implicit default profile. It is discoverable but not installable. */
export const DEFAULT_TEMPLATE_SUMMARY: ProfileTemplateSummary = {
  templateId: "default",
  profileId: DEFAULT_PROFILE.profileId,
  displayName: DEFAULT_PROFILE.displayName ?? "Default",
  version: null,
  publisher: "llmwiki",
  sourceType: "builtin",
  installable: false,
  capabilities: deriveTemplateCapabilities(DEFAULT_PROFILE),
};
