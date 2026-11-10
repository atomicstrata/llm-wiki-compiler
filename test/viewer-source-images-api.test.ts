/**
 * Source images on a real viewer server: source metadata lists the images a
 * source declares, and the image route serves their exact bytes on loopback and
 * nothing for names that are not one safe raster-image file or for a
 * non-loopback binding.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { useTempRoot } from "./fixtures/temp-root.js";
import { lanRequest } from "./fixtures/lan-request.js";
import { startViewerServer } from "../src/viewer/server.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("source image HTTP API", () => {
  const ctx = useTempRoot(["sources/images"]);
  let handle: Awaited<ReturnType<typeof startViewerServer>> | undefined;
  afterEach(async () => { await handle?.close(); handle = undefined; });

  async function start(host = "127.0.0.1", sourceFilenames: string[] = []): Promise<string> {
    const snapshot = { root: ctx.dir, sourceFilenames } as unknown as ViewerSnapshot;
    handle = await startViewerServer(snapshot, { host, port: 0 });
    return `http://127.0.0.1:${handle.port}`;
  }

  it("serves the exact bytes of a stored image with its content type", async () => {
    await writeFile(path.join(ctx.dir, "sources/images/shot.png"), PNG);
    const response = await fetch(`${await start()}/api/source-image/shot.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it.each([
    ["a file outside the image directory", "..%2F..%2Fsecret.png"],
    ["a nested path", "nested%2Fshot.png"],
    ["a scriptable SVG", "drawing.svg"],
    ["a non-image file", "notes.md"],
  ])("rejects %s", async (_label, name) => {
    await mkdir(path.join(ctx.dir, "sources/images/nested"), { recursive: true });
    await writeFile(path.join(ctx.dir, "sources/images/nested/shot.png"), PNG);
    await writeFile(path.join(ctx.dir, "sources/images/drawing.svg"), "<svg/>");
    const response = await fetch(`${await start()}/api/source-image/${name}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_source_image" } });
  });

  it("lists the images a source declares, keeping only names the route serves", async () => {
    const declared = '["shot.png", "../secret.png", "nested/shot.png", "drawing.svg", 7]';
    await writeFile(path.join(ctx.dir, "sources/shot.md"), `---\nimages: ${declared}\n---\nKiln log.\n`);
    await writeFile(path.join(ctx.dir, "sources/plain.md"), "---\ntitle: Plain\n---\nNo images.\n");
    const base = await start("127.0.0.1", ["shot.md", "plain.md"]);
    expect((await (await fetch(`${base}/api/source/shot.md`)).json()).images).toEqual(["shot.png"]);
    expect(await (await fetch(`${base}/api/source/plain.md`)).json()).not.toHaveProperty("images");
  });

  it("reports a missing image without leaking the requested name", async () => {
    const response = await fetch(`${await start()}/api/source-image/absent.png`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("absent.png");
  });

  it("serves no image bytes on a non-loopback binding", async () => {
    await writeFile(path.join(ctx.dir, "sources/images/shot.png"), PNG);
    await start("0.0.0.0");
    const response = await lanRequest(handle!.port, "/api/source-image/shot.png");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "loopback_required" } });
  });
});
