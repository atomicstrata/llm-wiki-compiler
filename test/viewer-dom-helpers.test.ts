/**
 * Unit tests for the shared element builders.
 *
 * These helpers are the only sanctioned way viewer modules create DOM, so
 * their contract is pinned here rather than re-asserted in each consumer.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { readFile } from "fs/promises";
import path from "path";

const MODULE_PATH = path.resolve("src/viewer/assets/viewer-dom.js");

interface DomHelpers {
  el(tag: string, className?: string, text?: string): HTMLElement;
  heading(tag: string, text: string): HTMLElement;
  placeholder(text: string): HTMLElement;
  emptyState(title: string, body: string, command?: string): HTMLElement;
}

let helpers: DomHelpers;
let dom: JSDOM;

beforeEach(async () => {
  const source = await readFile(MODULE_PATH, "utf-8");
  dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const body = source.replace(/export\s+function\s+/g, "function ");
  dom.window.eval(
    `${body}\nwindow.__helpers = { el, heading, placeholder, emptyState };`,
  );
  helpers = (dom.window as unknown as { __helpers: DomHelpers }).__helpers;
});

describe("viewer-dom helpers", () => {
  it("builds an element with a class and text", () => {
    const node = helpers.el("span", "chip", "hello");
    expect(node.tagName).toBe("SPAN");
    expect(node.className).toBe("chip");
    expect(node.textContent).toBe("hello");
  });

  it("omits the class attribute when no class is given", () => {
    expect(helpers.el("div").hasAttribute("class")).toBe(false);
  });

  it("sets text content rather than markup", () => {
    const node = helpers.el("div", undefined, "<b>x</b>");
    expect(node.querySelector("b")).toBeNull();
    expect(node.textContent).toBe("<b>x</b>");
  });

  it("builds a placeholder paragraph", () => {
    const node = helpers.placeholder("Nothing here");
    expect(node.tagName).toBe("P");
    expect(node.className).toBe("placeholder");
  });

  it("builds an empty state with a title, body, and command", () => {
    const node = helpers.emptyState("No saved queries yet", "Queries are pages too.", '$ llmwiki ask "…"');
    expect(node.className).toBe("empty-state");
    expect(node.querySelector(".empty-state-title")?.textContent).toBe("No saved queries yet");
    expect(node.querySelector(".empty-state-command")?.textContent).toBe('$ llmwiki ask "…"');
  });

  it("omits the command chip when no command applies", () => {
    const node = helpers.emptyState("Nothing compiled yet", "Run a compile to populate this.");
    expect(node.querySelector(".empty-state-command")).toBeNull();
  });
});
