/**
 * @file test/storage/connector-config-binding.test.ts
 * @description Connector config as ONE body over one physical leaf read,
 * `loadConnectorConfigFrom`, with no project directory: absence means registry
 * defaults, each untrusted shape keeps its own reason, and local config can only
 * tighten. The root form `loadConnectorConfig(root, …)` answers the same projects
 * on real disk.
 *
 * NOT SHOWN HERE: the confined directory resolution and the capped no-follow read
 * themselves (links, caps, confinement); the confined-read and private-dir suites
 * and `test/connectors/config.test.ts` show those.
 */

import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import {
  loadConnectorConfig, loadConnectorConfigFrom, type ConnectorConfigLeaf, type ConnectorConfigLeafRead,
} from "../../src/connectors/config.js";
import { MAX_LOCAL_CONFIG_BYTES } from "../../src/utils/constants.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import * as privateDir from "../../src/utils/private-dir.js";
import { tempRootTracker } from "../temp-roots.js";
import { writeFiles } from "./copied-project.js";
import { answerConfigProjects, projectConfigLeafOf as leafOf, PROJECT_CONFIG as CONFIG, type ConfigProjectFiles } from "./project-config-projects.js";

const PREFIX = "connector-config-binding-";
const HOSTS = ["api.crossref.org", "export.arxiv.org"];
const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** Projects by name: their files (`null` = no `.llmwiki` at all). */
const PROJECTS: Record<string, ConfigProjectFiles> = {
  "no private dir": null,
  "no config": { ".llmwiki/profile.json": "{}" },
  corrupt: { [CONFIG]: "{not json" },
  "connectors not an object": { [CONFIG]: JSON.stringify({ connectors: [] }) },
  "widens hosts": { [CONFIG]: JSON.stringify({ connectors: { crossref: { allowedHosts: ["evil.example"] } } }) },
  tightens: { [CONFIG]: JSON.stringify({ connectors: { crossref: { allowedHosts: ["api.crossref.org"], minRequestIntervalMs: 50, contactEmail: "ops@example.org" } } }) },
  "other connector only": { [CONFIG]: JSON.stringify({ connectors: { arxiv: {} } }) },
};

const scripted = (read: ConnectorConfigLeafRead): ConnectorConfigLeaf => ({ readConfig: async () => read });

describe("connector config over one physical read", () => {
  it("K1 answers every project exactly as the root form does on disk", async () => {
    const { onDisk, inMemory } = await answerConfigProjects(tracker, PREFIX, PROJECTS, {
      onDisk: (root) => loadConnectorConfig(root, "crossref", HOSTS, 100),
      inMemory: (leaf) => loadConnectorConfigFrom(leaf, "crossref", HOSTS, 100),
    });
    expect(inMemory).toEqual(onDisk);
    // The case only witnesses each rule when the disk applied it.
    expect(onDisk).toMatchObject({
      "no private dir": { kind: "absent" }, "no config": { kind: "absent" }, corrupt: { kind: "unavailable", reason: "config-corrupt" },
      "connectors not an object": { kind: "unavailable", reason: "connectors-schema" }, "widens hosts": { kind: "unavailable", reason: "allowed-hosts-widen" },
      tightens: { kind: "ok", config: { allowedHosts: ["api.crossref.org"], minRequestIntervalMs: 100, contactEmail: "ops@example.org" } },
      "other connector only": { kind: "absent", config: { allowedHosts: HOSTS, minRequestIntervalMs: 100 } },
    });
  });

  it("K2 keeps each physical outcome distinct: a directory fault and an unreadable leaf are unavailable for different reasons", async () => {
    const outcome = (read: ConnectorConfigLeafRead) => loadConnectorConfigFrom(scripted(read), "crossref", HOSTS, 100);
    expect(await Promise.all([outcome({ kind: "dir-unavailable" }), outcome({ kind: "unavailable" }), outcome({ kind: "dir-absent" }), outcome({ kind: "absent" })]))
      .toEqual([
        { kind: "unavailable", reason: "config-dir-unavailable" }, { kind: "unavailable", reason: "config-unavailable" },
        { kind: "absent", config: { allowedHosts: HOSTS, minRequestIntervalMs: 100 } }, { kind: "absent", config: { allowedHosts: HOSTS, minRequestIntervalMs: 100 } },
      ]);
  });

  it("K3 the bound route reaches neither mechanism, while the root form reaches both with its root and the leaf path", async () => {
    const resolve = vi.spyOn(privateDir, "resolveExistingConfinedPrivateDir");
    const read = vi.spyOn(confinedRead, "readCappedNoFollow");
    await loadConnectorConfigFrom(leafOf(PROJECTS.tightens!), "crossref", HOSTS, 100);
    expect([resolve.mock.calls.length, read.mock.calls.length]).toEqual([0, 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, PROJECTS.tightens!);
    await loadConnectorConfig(root, "crossref", HOSTS, 100);
    const dir = await resolve.mock.results[0]!.value as string;
    expect([resolve.mock.calls, read.mock.calls]).toEqual([[[root]], [[path.join(dir, "config.json"), MAX_LOCAL_CONFIG_BYTES]]]);
  });
});
