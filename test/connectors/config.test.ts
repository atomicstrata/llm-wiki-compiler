/**
 * @file test/connectors/config.test.ts
 * @description Connector activation env and tighten-only etiquette config.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorActivated, loadConnectorConfig } from "../../src/connectors/config.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(path.join(root.dir, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root.dir, ".llmwiki", "config.json"), JSON.stringify(config), "utf8");
}

describe("connector activation", () => {
  afterEach(() => {
    delete process.env.LLMWIKI_CONNECTORS;
  });

  it("reads activation only from LLMWIKI_CONNECTORS", () => {
    process.env.LLMWIKI_CONNECTORS = "crossref, fixture";
    expect(isConnectorActivated("crossref")).toBe(true);
    expect(isConnectorActivated("fixture")).toBe(true);
    expect(isConnectorActivated("nope")).toBe(false);
  });
});

describe("connector config", () => {
  it("loads tighten-only etiquette config without activation", async () => {
    await writeConfig({
      connectors: {
        crossref: {
          contactEmail: "ops@example.com",
          minRequestIntervalMs: 2000,
          allowedHosts: ["api.crossref.org"],
        },
      },
    });
    const cfg = await loadConnectorConfig(root.dir, "crossref", ["api.crossref.org"], 1000);
    expect(cfg.kind).toBe("ok");
    if (cfg.kind === "ok") {
      expect(cfg.config.contactEmail).toBe("ops@example.com");
      expect(cfg.config.minRequestIntervalMs).toBe(2000);
      expect(cfg.config.allowedHosts).toEqual(["api.crossref.org"]);
    }
  });

  it("rejects CRLF in contactEmail", async () => {
    await writeConfig({
      connectors: {
        crossref: { contactEmail: "a@example.com\r\nX-Bad: yes" },
      },
    });
    const cfg = await loadConnectorConfig(root.dir, "crossref", ["api.crossref.org"], 1000);
    expect(cfg.kind).toBe("unavailable");
  });

  it("rejects allowedHosts outside the registry allowlist", async () => {
    await writeConfig({
      connectors: {
        crossref: { allowedHosts: ["api.crossref.org", "169.254.169.254"] },
      },
    });
    const cfg = await loadConnectorConfig(root.dir, "crossref", ["api.crossref.org"], 1000);
    expect(cfg.kind).toBe("unavailable");
  });

  it("never lowers the registry request interval floor", async () => {
    await writeConfig({
      connectors: {
        crossref: { minRequestIntervalMs: 10 },
      },
    });
    const cfg = await loadConnectorConfig(root.dir, "crossref", ["api.crossref.org"], 1000);
    expect(cfg.kind).toBe("ok");
    if (cfg.kind === "ok") expect(cfg.config.minRequestIntervalMs).toBe(1000);
  });
});
