/** Reader-facing labels preserve exact identifiers without making them the primary UI. */
import { beforeEach, expect, it, vi } from "vitest";
import { useViewerDocument } from "./fixtures/viewer-document.js";
import { renderEntityContext } from "../src/viewer/assets/viewer-entity-context.js";
import { buildEntityFields } from "../src/viewer/assets/viewer-entity-fields.js";
import { renderPipeline } from "../src/viewer/assets/viewer-pipeline.js";
import { decorateArtifactRefs } from "../src/viewer/assets/viewer-access-detail.js";
import { buildConnections } from "../src/viewer/assets/viewer-connections.js";

const context = useViewerDocument();
let main: HTMLElement;
beforeEach(() => { main = context.main; });

it.each([
  ["incoming", "Follow-up idea builds on this record."],
  ["outgoing", "This record builds on Follow-up idea."],
  ["symmetric", "Follow-up idea — builds on — this record."],
])("explains %s connections without reversing their meaning", (direction, expected) => {
  renderEntityContext(main, { entityType: "papers", entityContext: { relations: [
    { type: "builds-on", direction, target: { id: "ideas/followup", title: "Follow-up idea", resolved: true } },
  ], sources: [] } });
  expect(main.querySelector("li")?.textContent).toBe(expected);
  expect(main.querySelector('a[href="#/ideas/followup"]')?.textContent).toBe("Follow-up idea");
  expect(main.textContent).toContain("Connected records");
});

it("keeps import hashes in a closed disclosure while explaining the metadata link", () => {
  renderEntityContext(main, { entityType: "papers", entityContext: { relations: [], sources: [], connector: {
    connectorId: "crossref", connectorVersion: "1", fetchedAt: "2026-09-08", contentHash: "abc123", sourceUrl: "https://example.org/api",
  } } });
  const details = main.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("abc123");
  expect(main.querySelector('a[href="https://example.org/api"]')?.textContent).toBe("View imported metadata (not the paper)");
});

it("labels fields for readers while preserving exact keys in technical details", () => {
  main.append(buildEntityFields([{ name: "outputKind", type: "string" }], { outputKind: "report" })!);
  expect(main.querySelector("dt")?.textContent).toBe("Output type");
  expect(main.querySelector("details")?.textContent).toContain("outputKind");
});

it("leads attachments with a filename and retains the reference under technical details", async () => {
  main.innerHTML = '<dd><span class="entity-field-ref">report/a@sha256:abc</span></dd>';
  vi.stubGlobal("fetch", async () => Response.json({ health: "ok", fileName: "report.txt", contentAccess: "available", manifest: { bytes: 10 } }));
  await decorateArtifactRefs(main, {});
  expect(main.querySelector(".artifact-detail")?.firstElementChild?.textContent).toBe("report.txt");
  expect(main.querySelector(".entity-field-ref")?.closest("details")?.textContent).toContain("report/a@sha256:abc");
  expect(main.querySelector("details")?.hasAttribute("open")).toBe(false);
  expect(main.querySelector("button")?.textContent).toBe("Preview");
});

it("opens the recorded connections and links their real records", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ nodes: [
    { id: "ideas/a", title: "Idea A" }, { id: "papers/b", title: "Paper B" },
  ], edges: [{ edgeKind: "relation", relationType: "builds-on", source: "ideas/a", target: "papers/b" }] }));
  renderPipeline(main, { profilePipeline: { entityTypes: [{ type: "ideas", pageCount: 1 }], relationTypes: [
    { type: "builds-on", from: ["ideas"], to: ["papers"], direction: "directed", count: 1 },
  ] } });
  const button = main.querySelector<HTMLButtonElement>(".pipeline-relation-count button");
  expect(button).not.toBeNull();
  button!.click();
  await vi.waitFor(() => expect(main.querySelector('a[href="#/ideas/a"]')?.textContent).toBe("Idea A"));
  expect(main.querySelector('a[href="#/papers/b"]')?.textContent).toBe("Paper B");
});

it("keeps missing endpoints unlinked and empty definitions noninteractive", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ nodes: [{ id: "ideas/a", title: "Idea", isDangling: true }],
    edges: [{ edgeKind: "relation", relationType: "tests", source: "ideas/a", target: "papers/missing" }] }));
  main.append(buildConnections([{ type: "tests", count: 1 }, { type: "supports", count: 0 }]));
  expect(main.querySelector('[data-relation-type="supports"] button')).toBeNull();
  expect(main.querySelector('[data-relation-type="supports"]')?.textContent).toContain("No links yet");
  main.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(main.querySelector(".connection-records")?.textContent).toContain("record not found"));
  expect(main.querySelector(".connection-records a")).toBeNull();
});

it("offers a retry after a failed connection read", async () => {
  vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
  main.append(buildConnections([{ type: "tests", count: 1 }]));
  const button = main.querySelector<HTMLButtonElement>("button")!;
  button.click();
  await vi.waitFor(() => expect(main.textContent).toContain("Close and reopen"));
  expect(button.disabled).toBe(false);
  button.click();
  expect(main.querySelector<HTMLElement>(".connection-records")?.hidden).toBe(true);
});
