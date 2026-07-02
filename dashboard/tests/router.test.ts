import { describe, it, expect } from "vitest";
import {
  matchRoute,
  navigate,
  pathUnderBase,
  BASE_PATH,
  createRouter,
  type Route,
} from "../src/router.js";

const noop = (): void => {};

const routes: Route[] = [
  { pattern: "/", render: noop },
  { pattern: "/login", render: noop },
  { pattern: "/devices", render: noop },
  { pattern: "/devices/:id", render: noop },
  { pattern: "/verify/:token", render: noop },
  { pattern: "*", render: noop },
];

describe("matchRoute", () => {
  it("matches root", () => {
    const m = matchRoute(routes, "/");
    expect(m?.route.pattern).toBe("/");
    expect(m?.params).toEqual({});
  });

  it("matches static segment", () => {
    const m = matchRoute(routes, "/login");
    expect(m?.route.pattern).toBe("/login");
  });

  it("matches dynamic segment and captures it", () => {
    const m = matchRoute(routes, "/devices/123-456-789");
    expect(m?.route.pattern).toBe("/devices/:id");
    expect(m?.params).toEqual({ id: "123-456-789" });
  });

  it("treats trailing slash as no trailing slash", () => {
    expect(matchRoute(routes, "/login/")?.route.pattern).toBe("/login");
    expect(matchRoute(routes, "/devices/123/")?.route.pattern).toBe("/devices/:id");
  });

  it("falls back to '*' when no static or dynamic route matches", () => {
    const m = matchRoute(routes, "/totally-unknown");
    expect(m?.route.pattern).toBe("*");
  });

  it("prefers static over dynamic when both could match", () => {
    // /devices is static; the dynamic /devices/:id is one segment longer
    // and shouldn't intercept the static one.
    expect(matchRoute(routes, "/devices")?.route.pattern).toBe("/devices");
  });

  it("decodes URL-encoded params", () => {
    const m = matchRoute(routes, "/verify/abc%2Fdef");
    expect(m?.params).toEqual({ token: "abc/def" });
  });

  it("requires exact segment count", () => {
    // /devices/:id has 2 segments; /devices/123/extra has 3 → no match,
    // falls through to '*'.
    expect(matchRoute(routes, "/devices/123/extra")?.route.pattern).toBe("*");
  });

  it("returns null when there is no fallback route", () => {
    const m = matchRoute(
      [
        { pattern: "/", render: noop },
        { pattern: "/login", render: noop },
      ],
      "/totally-unknown",
    );
    expect(m).toBeNull();
  });
});

describe("pathUnderBase", () => {
  it("maps the bare base path to /", () => {
    expect(pathUnderBase(BASE_PATH)).toBe("/");
    expect(pathUnderBase(BASE_PATH + "/")).toBe("/");
  });

  it("strips the base prefix", () => {
    expect(pathUnderBase(BASE_PATH + "/login")).toBe("/login");
    expect(pathUnderBase(BASE_PATH + "/devices/123-456-789")).toBe(
      "/devices/123-456-789",
    );
  });

  it("returns / for paths outside the base", () => {
    expect(pathUnderBase("/")).toBe("/");
    expect(pathUnderBase("/something-else")).toBe("/");
  });
});

// CQ H-5 (review 2026-05-13): the module-level `navigate()` singleton
// is the replacement for the 12+ pushState+popstate copies that used
// to live in every view. The contract: a view calls `navigate(path)`
// and the active router (if any) re-renders. With no active router,
// fall back to plain pushState so the dashboard still works during
// rapid test cycles where the router was torn down.
describe("navigate (module-level singleton)", () => {
  it("falls back to plain pushState when no router is active", () => {
    // No router constructed in this test — direct navigate.
    const startPath = window.location.pathname;
    navigate("/login");
    expect(window.location.pathname).toBe(BASE_PATH + "/login");
    // Restore so subsequent tests don't drift.
    window.history.pushState({}, "", startPath);
  });

  it("delegates to the active router and renders the new view", () => {
    let lastPath: string | null = null;
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/login",
        render: (_root, ctx) => {
          lastPath = ctx.path;
        },
      },
      {
        pattern: "/devices",
        render: (_root, ctx) => {
          lastPath = ctx.path;
        },
      },
    ];
    const r = createRouter(root, rs);
    r.start();
    navigate("/devices");
    expect(window.location.pathname).toBe(BASE_PATH + "/devices");
    expect(lastPath).toBe("/devices");
    r.stop();
  });

  it("stop() unregisters the singleton — subsequent navigate hits the fallback", () => {
    const root = document.createElement("div");
    const rs: Route[] = [{ pattern: "/", render: () => undefined }];
    const r = createRouter(root, rs);
    r.start();
    r.stop();
    // After stop the active-router slot is null; navigate falls back.
    // No crash, no render call.
    navigate("/");
    expect(window.location.pathname).toBe(BASE_PATH + "/");
  });
});

// gh #53 — adminOnly route gating. The router substitutes the
// forbidden-renderer for adminOnly routes when isAdmin() is false,
// and renders the route normally when isAdmin() is true. Backend's
// requireAdmin remains the real gate; this branch is UX-only.
describe("admin-only route gating (gh #53)", () => {
  it("renders the matched view when isAdmin()===true", () => {
    let rendered = "";
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/admin/feedback",
        adminOnly: true,
        render: () => {
          rendered = "feedback";
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/admin/feedback");
    const r = createRouter(root, rs, undefined, undefined, {
      isAdmin: () => true,
      renderAdminForbidden: () => {
        rendered = "forbidden";
      },
    });
    r.start();
    expect(rendered).toBe("feedback");
    r.stop();
  });

  it("substitutes renderAdminForbidden when isAdmin()===false", () => {
    let rendered = "";
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/admin/feedback",
        adminOnly: true,
        render: () => {
          rendered = "feedback";
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/admin/feedback");
    const r = createRouter(root, rs, undefined, undefined, {
      isAdmin: () => false,
      renderAdminForbidden: () => {
        rendered = "forbidden";
      },
    });
    r.start();
    expect(rendered).toBe("forbidden");
    r.stop();
  });

  it("leaves non-admin routes alone even when isAdmin()===false", () => {
    let rendered = "";
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/devices",
        render: () => {
          rendered = "devices";
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/devices");
    const r = createRouter(root, rs, undefined, undefined, {
      isAdmin: () => false,
      renderAdminForbidden: () => {
        rendered = "forbidden";
      },
    });
    r.start();
    expect(rendered).toBe("devices");
    r.stop();
  });

  it("dispatches dashboard:rendered after every render (nav-active-highlighter hook)", () => {
    const events: string[] = [];
    const root = document.createElement("div");
    const rs: Route[] = [
      { pattern: "/", render: () => undefined },
      { pattern: "/devices", render: () => undefined },
    ];
    window.addEventListener("dashboard:rendered", () => events.push("rendered"));
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start(); // initial render → 1 event
    navigate("/devices"); // navigation → 2 events
    expect(events.length).toBe(2);
    r.stop();
  });
});

// Review 2026-07-02 — F1 (navigation race) + F3 (listener leak).
describe("render isolation + listener teardown", () => {
  it("a slow async view render does not clobber the page after navigation (F1)", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let containerA: HTMLElement | null = null;
    const rs: Route[] = [
      {
        pattern: "/a",
        render: (r) => {
          // Capture the container but write nothing yet — simulates a view
          // that awaits a fetch and populates `root` later.
          containerA = r;
        },
      },
      {
        pattern: "/b",
        render: (r) => {
          r.textContent = "B";
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/a");
    const r = createRouter(root, rs);
    r.start(); // renders A into container-A
    navigate("/b"); // renders B into a fresh container; container-A detaches

    // A's late async completion writes into its captured (now-detached)
    // container — this must NOT overwrite the visible page.
    containerA!.textContent = "A (late)";
    expect(root.textContent).toBe("B");

    r.stop();
    document.body.removeChild(root);
  });

  it("stop() removes the document click interceptor (F3)", () => {
    const root = document.createElement("div");
    let renders = 0;
    const rs: Route[] = [
      { pattern: "/", render: () => void renders++ },
      { pattern: "/devices", render: () => void renders++ },
    ];
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start(); // initial render
    r.stop();
    const before = renders;

    // After stop, a click on an internal dashboard link must NOT be
    // intercepted (no pushState, no re-render). Before the fix the anonymous
    // handler was never removed, so a "stopped" router kept hijacking clicks.
    const link = document.createElement("a");
    link.href = BASE_PATH + "/devices";
    document.body.appendChild(link);
    link.click();
    expect(renders).toBe(before);
    document.body.removeChild(link);
  });
});
