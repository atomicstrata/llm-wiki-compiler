/**
 * @file test/fixtures/template-tap-runtime.ts
 * @description Shared offline runtime harness for signed template-tap tests.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ConfinedFetchSeams } from "../../src/connectors/confined-fetch.js";
import { addTap } from "../../src/profile/templates/taps/manage.js";
import { resolveTapPaths, type TapPaths } from "../../src/profile/templates/taps/paths.js";
import { refreshTap } from "../../src/profile/templates/taps/refresh.js";

const FIXTURE = path.join(process.cwd(), "test/fixtures/template-registry");
export const TAP_KEY = {
  keyId: "tap-key-1",
  publicKey: "MCowBQYDK2VwAyEA+Zh7GM2+2PTzR+DGzIIMyf9RW3z8iPX+y0ToR7vFF7Q=",
};

/** Return one deterministic public-network response seam. */
export function servesTemplateBytes(text: string): ConfinedFetchSeams {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([text]) }),
  };
}

/** Read one checked-in signing fixture as UTF-8 text. */
export function templateRegistryFixture(name: "index.json" | "package.json"): Promise<string> {
  return readFile(path.join(FIXTURE, name), "utf8");
}

/** Create isolated config/cache paths and register the cleanup root. */
export async function isolatedTapPaths(prefix: string, roots: string[]): Promise<TapPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return resolveTapPaths({ configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache") });
}

/** Configure and accept the checked-in signed index beneath an isolated root. */
export async function acceptTemplateTap(root: string, indexUrl = "https://tap.example/index.json"): Promise<TapPaths> {
  const paths = resolveTapPaths({ configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache") });
  await addTap(paths, { name: "official", indexUrl, key: TAP_KEY });
  await refreshTap(paths, "official", servesTemplateBytes(await templateRegistryFixture("index.json")));
  return paths;
}
