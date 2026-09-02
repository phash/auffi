import { describe, it, expect, beforeEach } from "vitest";
import { isAdminGatedPath, visibleRoutes, updateActiveNav } from "../src/admin-nav.js";
import { BASE_PATH, type Route } from "../src/router.js";

const noop = (): void => undefined;

const ROUTES: Route[] = [
  { pattern: "/", navLabel: "Übersicht", render: noop },
  { pattern: "/login", render: noop }, // no navLabel
  { pattern: "/devices", navLabel: "Geräte", render: noop },
  { pattern: "/account", navLabel: "Account", render: noop },
  { pattern: "/admin/feedback", navLabel: "Feedback (Admin)", adminOnly: true, render: noop },
  { pattern: "/admin/stats", navLabel: "Stats (Admin)", adminOnly: true, render: noop },
  { pattern: "*", render: noop },
];

describe("visibleRoutes", () => {
  it("includes admin-only routes when isAdmin=true", () => {
    const v = visibleRoutes(ROUTES, true).map((r) => r.pattern);
    expect(v).toEqual(["/", "/devices", "/account", "/admin/feedback", "/admin/stats"]);
  });

  it("hides admin-only routes when isAdmin=false (UX gate, backend still enforces)", () => {
    const v = visibleRoutes(ROUTES, false).map((r) => r.pattern);
    expect(v).toEqual(["/", "/devices", "/account"]);
  });

  it("never includes routes without navLabel, regardless of admin state", () => {
    const v = visibleRoutes(ROUTES, true);
    expect(v.find((r) => r.pattern === "/login")).toBeUndefined();
    expect(v.find((r) => r.pattern === "*")).toBeUndefined();
  });
});

describe("isAdminGatedPath", () => {
  it("is true for a pathname that resolves to an adminOnly route", () => {
    expect(isAdminGatedPath(ROUTES, BASE_PATH + "/admin/feedback")).toBe(true);
    expect(isAdminGatedPath(ROUTES, BASE_PATH + "/admin/stats/")).toBe(true);
  });

  it("is false for public routes, the fallback and paths outside the base", () => {
    expect(isAdminGatedPath(ROUTES, BASE_PATH + "/devices")).toBe(false);
    expect(isAdminGatedPath(ROUTES, BASE_PATH + "/nope")).toBe(false);
    expect(isAdminGatedPath(ROUTES, "/")).toBe(false);
  });
});

describe("updateActiveNav", () => {
  let nav: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    nav = document.createElement("nav");
    const links: Array<[string, string]> = [
      ["/dashboard/", "Übersicht"],
      ["/dashboard/devices", "Geräte"],
      ["/dashboard/account", "Account"],
    ];
    for (const [href, label] of links) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      nav.appendChild(a);
    }
    document.body.appendChild(nav);
  });

  it("marks the matching link with .active + aria-current=page", () => {
    updateActiveNav(nav, "/dashboard/devices");
    const links = Array.from(nav.querySelectorAll("a"));
    const active = links.filter((a) => a.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0].getAttribute("href")).toBe("/dashboard/devices");
    expect(active[0].getAttribute("aria-current")).toBe("page");
  });

  it("removes .active + aria-current from other links", () => {
    updateActiveNav(nav, "/dashboard/devices");
    updateActiveNav(nav, "/dashboard/account");
    const dev = nav.querySelector('a[href="/dashboard/devices"]')!;
    const acc = nav.querySelector('a[href="/dashboard/account"]')!;
    expect(dev.classList.contains("active")).toBe(false);
    expect(dev.hasAttribute("aria-current")).toBe(false);
    expect(acc.classList.contains("active")).toBe(true);
    expect(acc.getAttribute("aria-current")).toBe("page");
  });

  it("no-ops when currentPath matches nothing (no active link, no crash)", () => {
    updateActiveNav(nav, "/dashboard/no-such-route");
    expect(nav.querySelectorAll("a.active").length).toBe(0);
  });
});
