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

  it("falls back to the raw segment on malformed percent-encoding instead of throwing", () => {
    // Crafted/truncated links can carry invalid escapes ("/devices/50%",
    // "/verify/%zz") — decodeURIComponent would throw URIError.
    const m = matchRoute(routes, "/devices/50%");
    expect(m?.route.pattern).toBe("/devices/:id");
    expect(m?.params).toEqual({ id: "50%" });
    const v = matchRoute(routes, "/verify/%zz");
    expect(v?.params).toEqual({ token: "%zz" });
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

  it("refresh() re-renders the current route without pushing history", () => {
    let renders = 0;
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/",
        render: () => {
          renders += 1;
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start();
    expect(renders).toBe(1);
    r.refresh();
    expect(renders).toBe(2);
    expect(window.location.pathname).toBe(BASE_PATH + "/");
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

// Review 2026-08: start() registers a document-level click interceptor —
// stop() must detach it again (tests construct multiple routers), and a
// second start() must not stack duplicate handlers.
describe("start/stop lifecycle", () => {
  function clickInternalLink(path: string): void {
    const a = document.createElement("a");
    a.href = BASE_PATH + path;
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    a.remove();
  }

  it("stop() removes the document click interceptor", () => {
    let renders = 0;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rs: Route[] = [
      { pattern: "/", render: () => void (renders += 1) },
      { pattern: "/devices", render: () => void (renders += 1) },
    ];
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start(); // 1 render
    r.stop();
    // The router's interceptor is gone — swallow jsdom's default
    // anchor navigation so the click stays inert.
    document.addEventListener("click", (e) => e.preventDefault(), { once: true });
    clickInternalLink("/devices");
    expect(renders).toBe(1);
    expect(window.location.pathname).toBe(BASE_PATH + "/");
    root.remove();
  });

  it("start() twice does not stack duplicate click handlers or double-render", () => {
    let renders = 0;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rs: Route[] = [
      { pattern: "/", render: () => void (renders += 1) },
      { pattern: "/devices", render: () => void (renders += 1) },
    ];
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start();
    r.start(); // guarded — no second registration, no extra render
    expect(renders).toBe(1);
    clickInternalLink("/devices");
    // Exactly one render (and one pushState) per link click.
    expect(renders).toBe(2);
    expect(window.location.pathname).toBe(BASE_PATH + "/devices");
    r.stop();
    root.remove();
  });
});

// Review 2026-08: renderers may return a cleanup function (timers,
// subscriptions). The router invokes it before the next render and on
// stop() so views can't leak intervals against detached DOM.
describe("renderer cleanup contract", () => {
  it("invokes a returned cleanup before the next render and on stop()", () => {
    const calls: string[] = [];
    const root = document.createElement("div");
    const rs: Route[] = [
      {
        pattern: "/",
        render: () => {
          calls.push("render-home");
          return () => {
            calls.push("cleanup-home");
          };
        },
      },
      {
        pattern: "/devices",
        render: () => {
          calls.push("render-devices");
          return () => {
            calls.push("cleanup-devices");
          };
        },
      },
    ];
    window.history.pushState({}, "", BASE_PATH + "/");
    const r = createRouter(root, rs);
    r.start();
    navigate("/devices");
    r.stop();
    expect(calls).toEqual([
      "render-home",
      "cleanup-home",
      "render-devices",
      "cleanup-devices",
    ]);
  });
});
