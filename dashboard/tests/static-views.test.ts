import { describe, it, expect } from "vitest";
import { renderAdmin403 } from "../src/views/admin-403.js";
import { renderNotFound } from "../src/views/not-found.js";

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function ctx(path: string) {
  return { path, segments: path.split("/").filter(Boolean), params: {}, query: new URLSearchParams() };
}

describe("renderAdmin403", () => {
  it("replaces the previous view with the no-admin notice and a link home", () => {
    const root = makeRoot();
    root.appendChild(document.createElement("p")).textContent = "stale admin placeholder";
    renderAdmin403(root, ctx("/admin/users"));
    expect(root.textContent).not.toContain("stale admin placeholder");
    expect(root.querySelector("h1")?.textContent).toBe("Kein Admin-Zugang");
    const back = root.querySelector("a") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("/dashboard/");
    expect(back.textContent).toBe("Zur Übersicht");
  });
});

describe("renderNotFound", () => {
  it("names the unknown path and links back to the dashboard start", () => {
    const root = makeRoot();
    root.appendChild(document.createElement("p")).textContent = "previous view";
    renderNotFound(root, ctx("/gibts-nicht"));
    expect(root.textContent).not.toContain("previous view");
    expect(root.querySelector("h1")?.textContent).toBe("Seite nicht gefunden");
    expect(root.textContent).toContain("Die Seite /gibts-nicht existiert (noch) nicht.");
    expect((root.querySelector("a") as HTMLAnchorElement).getAttribute("href")).toBe("/dashboard/");
  });

  it("renders a hostile path as text, never as markup", () => {
    const root = makeRoot();
    renderNotFound(root, ctx("/<img src=x onerror=alert(1)>"));
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
