/**
 * @file test/fixtures/template-remote-update.ts
 * @description Offline signed two-release tap fixture for remote update tests.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import type { ProfileTemplatePackage } from "../../src/profile/templates/types.js";
import { installRemoteTemplate } from "../../src/profile/templates/install.js";
import { resolveRemotePackage } from "../../src/profile/templates/taps/package.js";
import { addTap } from "../../src/profile/templates/taps/manage.js";
import { resolveTapPaths } from "../../src/profile/templates/taps/paths.js";
import { refreshTap } from "../../src/profile/templates/taps/refresh.js";
import { makeTempRoot } from "./temp-root.js";
import { servesTemplateBytes, templateRegistryFixture } from "./template-tap-runtime.js";
import { remotePackage, signedIndex, signedPackage, TAP_KEY } from "./template-signing.js";

export const BASE_COORDINATE = "official/atomicstrata/team@1.0.0";
export const TARGET_COORDINATE = "official/atomicstrata/team@1.1.0";

/** Complete isolated installed base plus accepted/cached target release. */
export async function remoteUpdateFixture(roots: string[]) {
  const tapRoot = await makeTempRoot("remote-update-tap");
  const project = await makeTempRoot("remote-update-project");
  roots.push(tapRoot, project);
  const paths = resolveTapPaths({
    configRoot: path.join(tapRoot, "operator-config", "llmwiki"),
    cacheRoot: path.join(tapRoot, "operator-cache", "llmwiki", "templates"),
  });
  await addTap(paths, { name: "official", indexUrl: "https://tap.example/index.json", key: TAP_KEY });
  await refreshTap(paths, "official", servesTemplateBytes(await templateRegistryFixture("index.json")));
  const base = await resolveRemotePackage(paths, BASE_COORDINATE, {
    seams: servesTemplateBytes(await templateRegistryFixture("package.json")),
  });
  await installRemoteTemplate(project, paths, base, { force: false });
  const candidate = candidatePackage();
  const envelope = signedPackage(candidate, TARGET_COORDINATE);
  const nextIndex = signedIndex({
    sequence: 2,
    packages: [
      { coordinate: BASE_COORDINATE, publisher: "atomicstrata", payloadDigest: base.payloadDigest },
      { coordinate: TARGET_COORDINATE, publisher: "atomicstrata", payloadDigest: envelope.payloadDigest },
    ],
  });
  await refreshTap(paths, "official", servesTemplateBytes(JSON.stringify(nextIndex)));
  const target = await resolveRemotePackage(paths, TARGET_COORDINATE, {
    seams: servesTemplateBytes(JSON.stringify(envelope)),
  });
  return { paths, project, base, target, candidate };
}

/** Remove every fixture root registered by a test file. */
export async function removeRemoteUpdateRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

function candidatePackage(): ProfileTemplatePackage {
  const base = remotePackage();
  return {
    ...base,
    version: "1.1.0",
    profile: {
      ...base.profile,
      profileVersion: "1.1.0",
      entities: {
        ...base.profile.entities,
        items: {
          ...base.profile.entities.items,
          fields: { title: { type: "string" }, priority: { type: "integer" } },
        },
      },
    },
  };
}
