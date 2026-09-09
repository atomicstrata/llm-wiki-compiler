/** Real HTTP handlers reverify pinned content and preserve remote metadata-only access. */
import { afterEach, describe, it, expect } from "vitest";
import http from "http";
import { writeFile } from "fs/promises";
import path from "path";
import { useTempRoot } from "./fixtures/temp-root.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import { startViewerServer } from "../src/viewer/server.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

describe("content HTTP API", () => {
  const ctx = useTempRoot(["sources"]);
  let handle: Awaited<ReturnType<typeof startViewerServer>> | undefined;
  afterEach(async () => { await handle?.close(); handle = undefined; });
  const artifactDefinitions = { report: { fileName: "report.txt", contentKind: "text", maxBytes: 1000 } };
  async function start(host = "127.0.0.1") {
    const snapshot = { root: ctx.dir, sourceFilenames: ["paper.md"], artifactDefinitions } as unknown as ViewerSnapshot;
    handle = await startViewerServer(snapshot, { host, port: 0 });
    return `http://127.0.0.1:${handle.port}`;
  }
  it("verifies every download instead of trusting an earlier successful metadata read", async () => {
    const ref = await seedArtifact(ctx.dir, "report", "report.txt", "one", "trusted", "text");
    const base = await start();
    const query = `?ref=${encodeURIComponent(ref)}`;
    const metadata = await fetch(`${base}/api/artifact${query}`);
    expect(await metadata.json()).toMatchObject({ health: "ok", fileName: "report.txt" });
    expect(metadata.headers.get("Cache-Control")).toBe("no-store");
    const content = await fetch(`${base}/api/artifact/content${query}&download=1`);
    expect(content.headers.get("Content-Disposition")).toContain("attachment;");
    expect(await content.text()).toBe("trusted");
    await writeFile(path.join(ctx.dir, "artifacts/report/one/report.txt"), "changed");
    const changed = await fetch(`${base}/api/artifact/content${query}`);
    expect(changed.status).toBe(409);
    expect(await changed.text()).not.toContain("changed");
  });
  it("serves full physical source lines but no source body in the metadata response", async () => {
    const source = "---\ntitle: Paper\n---\nOriginal body";
    await writeFile(path.join(ctx.dir, "sources/paper.md"), source);
    const base = await start();
    const metadata = await (await fetch(`${base}/api/source/paper.md`)).json();
    expect(metadata).not.toHaveProperty("body");
    expect(await (await fetch(`${base}/api/source/paper.md/content`)).text()).toBe(source);
    expect((await fetch(`${base}/api/source/%2E%2E%2Fsecret.md/content`)).status).toBe(400);
  });
  it("denies actual remote content handlers while retaining safe metadata", async () => {
    await writeFile(path.join(ctx.dir, "sources/paper.md"), "remote secret");
    await start("0.0.0.0");
    const metadata = await lanRequest(handle!.port, "/api/source/paper.md");
    expect(metadata.status).toBe(200);
    expect(metadata.body).toContain('"health":"ok"');
    expect(metadata.body).not.toContain("remote secret");
    const content = await lanRequest(handle!.port, "/api/source/paper.md/content");
    expect(content.status).toBe(403);
    expect(content.body).not.toContain("remote secret");
  });
});

/** Match the LAN bind's required Host header without relying on fetch overriding it. */
function lanRequest(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers: { Host: `0.0.0.0:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}
