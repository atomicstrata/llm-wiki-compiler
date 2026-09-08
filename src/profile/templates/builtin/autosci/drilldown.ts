/**
 * AutoSci 0.4.0 adds optional drill-down links without changing published older
 * entity, artifact or relation objects. Existing projects acquire these through
 * explicit template update planning; no historical links are fabricated.
 */
import type { ProfilePack, EntityTypeDef } from "../../../types.js";
import { autosciEntities } from "./entities.js";
import { autosciArtifacts } from "./artifacts.js";
import { autosciRelations } from "./relations.js";

/** Optional links support text/JSON records or an external original locator. */
function withMaterialLinks(entity: EntityTypeDef): EntityTypeDef {
  return { ...entity, fields: { ...entity.fields,
    locator: { type: "string", format: "url" },
    artifact: { type: "artifactRef", artifactTypes: ["research-material", "research-material-metadata"] },
  } };
}

/** Declarative additions consumed by the generic entity viewer. */
export const autosciDrilldown: Pick<ProfilePack, "entities" | "artifacts" | "relations"> = {
  entities: { ...autosciEntities,
    foundations: withMaterialLinks(autosciEntities.foundations),
    "research-outputs": withMaterialLinks(autosciEntities["research-outputs"]),
  },
  artifacts: { ...autosciArtifacts,
    "research-material": { fileName: "material.txt", contentKind: "text", maxBytes: 262144 },
    "research-material-metadata": { fileName: "metadata.json", contentKind: "json", maxBytes: 65536,
      metadata: { description: { type: "string" }, locator: { type: "string", format: "url" } } },
  },
  relations: { ...autosciRelations,
    reviews: { from: ["reviews"], to: ["manuscripts"], direction: "directed" },
    authored: { from: ["people"], to: ["papers", "manuscripts", "research-outputs"], direction: "directed" },
    "contributed-to": { from: ["people"], to: ["experiments", "foundations", "research-outputs"], direction: "directed" },
  },
};
