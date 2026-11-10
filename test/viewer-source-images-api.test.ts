/**
 * Source images on a real viewer server: source metadata lists the images a
 * source declares, and the image route serves an image's exact bytes only
 * through a source in the snapshot that declares it, on a loopback binding.
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

  /** Start a viewer whose snapshot knows `sourceFilenames`. */
  async function start(sourceFilenames: string[], host = "127.0.0.1"): Promise<string> {
    const snapshot = { root: ctx.dir, sourceFilenames } as unknown as ViewerSnapshot;
    handle = await startViewerServer(snapshot, { host, port: 0 });
    return `http://127.0.0.1:${handle.port}`;
  }
  /** Write a source that declares `images` in its frontmatter. */
  const writeSource = (name: string, images: string): Promise<void> =>
    writeFile(path.join(ctx.dir, "sources", name), `---\nimages: ${images}\n---\nKiln log.\n`);
  const writeImage = (name: string): Promise<void> => writeFile(path.join(ctx.dir, "sources/images", name), PNG);

  it("serves the exact bytes of an image its source declares", async () => {
    await writeSource("shot.md", '["shot.png"]');
    await writeImage("shot.png");
    const response = await fetch(`${await start(["shot.md"])}/api/source-image/shot.md/shot.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("does not serve an image left behind after its source stopped declaring it", async () => {
    await writeSource("shot.md", '["other.png"]');
    await writeImage("orphan.png");
    const base = await start(["shot.md"]);
    expect((await fetch(`${base}/api/source-image/shot.md/orphan.png`)).status).toBe(404);
  });

  it("does not serve through a source that is not in the snapshot", async () => {
    await writeSource("removed.md", '["shot.png"]');
    await writeImage("shot.png");
    const base = await start([]);
    expect((await fetch(`${base}/api/source-image/removed.md/shot.png`)).status).toBe(404);
    expect((await fetch(`${base}/api/source-image/..%2Fremoved.md/shot.png`)).status).toBe(404);
  });

  it.each([
    ["an image name with no source", "shot.png"],
    ["a file outside the image directory", "shot.md/..%2F..%2Fsecret.png"],
    ["a nested image path", "shot.md/nested%2Fshot.png"],
    ["a scriptable SVG", "shot.md/drawing.svg"],
    ["a non-image file", "shot.md/notes.md"],
    ["an extra path segment", "shot.md/shot.png/extra"],
  ])("rejects %s", async (_label, target) => {
    await writeSource("shot.md", '["shot.png", "drawing.svg", "nested/shot.png"]');
    await mkdir(path.join(ctx.dir, "sources/images/nested"), { recursive: true });
    await writeImage("shot.png");
    const response = await fetch(`${await start(["shot.md"])}/api/source-image/${target}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_source_image" } });
  });

  it("lists the images a source declares, keeping only servable names", async () => {
    await writeSource("shot.md", '["shot.png", "../secret.png", "nested/shot.png", "drawing.svg", 7]');
    await writeFile(path.join(ctx.dir, "sources/plain.md"), "---\ntitle: Plain\n---\nNo images.\n");
    const base = await start(["shot.md", "plain.md"]);
    expect((await (await fetch(`${base}/api/source/shot.md`)).json()).images).toEqual(["shot.png"]);
    expect(await (await fetch(`${base}/api/source/plain.md`)).json()).not.toHaveProperty("images");
  });

  it("reports a declared but missing image without leaking the requested name", async () => {
    await writeSource("shot.md", '["absent.png"]');
    const response = await fetch(`${await start(["shot.md"])}/api/source-image/shot.md/absent.png`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("absent.png");
  });

  it("serves no image bytes on a non-loopback binding", async () => {
    await writeSource("shot.md", '["shot.png"]');
    await writeImage("shot.png");
    await start(["shot.md"], "0.0.0.0");
    const response = await lanRequest(handle!.port, "/api/source-image/shot.md/shot.png");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "loopback_required" } });
  });
});
