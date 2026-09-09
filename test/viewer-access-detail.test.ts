/** The access UI preserves physical source lines and never treats artifact text as HTML. */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { useViewerDocument } from "./fixtures/viewer-document.js";
import { renderSourceDetail, decorateArtifactRefs } from "../src/viewer/assets/viewer-access-detail.js";

describe("access detail UI", () => {
  let main: HTMLElement;
  const context = useViewerDocument();
  beforeEach(() => { main = context.main; });
  it("highlights physical cited lines while retaining the raw source header", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/content")
      ? new Response("---\ntitle: Paper\n---\n<script>untrusted</script>")
      : Response.json({ title: "Paper", health: "ok", contentAccess: "available" }));
    await renderSourceDetail(main, { filename: "paper.md", start: 4, end: 4 });
    expect(main.querySelector("mark")?.textContent).toContain("4  <script>untrusted</script>");
    expect(main.querySelector("script")).toBeNull();
    expect(main.textContent).toContain("1  ---");
  });
  it("does not request source bytes when metadata reports a nonloopback binding", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      return Response.json({ title: "Paper", health: "ok", contentAccess: "loopback-only" });
    });
    await renderSourceDetail(main, { filename: "paper.md" });
    expect(requests).toEqual(["/api/source/paper.md"]);
    expect(main.textContent).toContain("localhost");
  });
  it("replaces an unresolved artifact with health and safe preview controls", async () => {
    main.innerHTML = '<dd><span class="entity-field-ref">report/a@sha256:abc</span><span class="entity-field-unresolved">Unresolved</span></dd>';
    vi.stubGlobal("fetch", async () => Response.json({ health: "ok", fileName: "report.txt", contentAccess: "available", manifest: { bytes: 10 } }));
    await decorateArtifactRefs(main, {});
    expect(main.querySelector(".entity-field-unresolved")).toBeNull();
    expect(main.textContent).toContain("report.txt");
    expect(main.querySelector("button")?.textContent).toBe("Preview");
    expect(main.querySelector("a")?.href).toContain("download=1");
  });
  it("labels bounded verification and leaves excess references explicitly unverified", async () => {
    main.innerHTML = '<section data-entity-context></section>' + '<dd><span class="entity-field-ref">ref</span></dd>'.repeat(101);
    vi.stubGlobal("fetch", async () => Response.json({ health: "artifact-dangling", contentAccess: "available" }));
    await decorateArtifactRefs(main, {});
    expect(main.querySelectorAll(".artifact-detail")).toHaveLength(100);
    expect(main.querySelector(".artifact-limit")?.textContent).toContain("100 of 101");
    expect(main.querySelector("button")).toBeNull();
  });
  it("links a recorded web origin but leaves unsafe locators inert", async () => {
    for (const locator of ["https://example.org/paper", "javascript:alert(1)"]) {
      vi.stubGlobal("fetch", async () => Response.json({ title: "Paper", health: "ok", contentAccess: "loopback-only", locator }));
      await renderSourceDetail(main, { filename: "paper.md" });
      expect(main.querySelectorAll(".source-locator")).toHaveLength(locator.startsWith("https:") ? 1 : 0);
    }
  });
  it("states that no artifacts are attached only within typed entity context", async () => {
    await decorateArtifactRefs(main, {});
    expect(main.textContent).toBe("");
    main.innerHTML = '<section data-entity-context></section>';
    await decorateArtifactRefs(main, {});
    expect(main.textContent).toBe("No files attached.");
  });
});
