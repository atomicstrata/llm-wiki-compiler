/**
 * @file src/profile/templates/builtin/autosci/relations.ts
 * @description Relation definitions for the shipped AutoSci profile template.
 */
import type { ProfilePack } from "../../../types.js";

/** AutoSci relation vocabulary copied from the reviewed research proof fixture. */
export const autosciRelations = {
  cites: { from: ["papers", "manuscripts"], to: ["sources", "papers"], direction: "directed" },
  "builds-on": { from: ["ideas"], to: ["papers", "ideas"], direction: "directed" },
  tests: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  challenges: { from: ["manuscripts", "ideas"], to: ["papers", "ideas"], direction: "directed" },
  "introduces-concept": { from: ["papers"], to: ["research-concepts"], direction: "directed" },
  "uses-concept": { from: ["methods", "experiments", "manuscripts"], to: ["research-concepts"], direction: "directed" },
  "proposes-method": { from: ["papers"], to: ["methods"], direction: "directed" },
  "extends-method": { from: ["methods"], to: ["methods"], direction: "directed" },
  supports: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  contradicts: { from: ["experiments"], to: ["ideas"], direction: "directed" },
  "derived-from": { from: ["research-outputs", "methods"], to: ["experiments", "foundations"], direction: "directed" },
  "addresses-gap": { from: ["ideas"], to: ["topics"], direction: "directed" },
} satisfies NonNullable<ProfilePack["relations"]>;
