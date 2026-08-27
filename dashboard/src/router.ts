// Tiny history-API router for the dashboard.
//
// Why no React-Router / vue-router / similar: the dashboard has ~7
// routes total (per spec section 8.2) so the dep + bundle bloat
// of a full router framework isn't justified. This module mounts
// the matched view's renderer into `#dashboard-root` on each
// pushState / popstate and exposes a `navigate(path)` helper that
// the views can call instead of touching `history` directly.
//
// All routes live under `/dashboard/*` (the Caddy reverse-proxy
// mounts the bundle at that prefix). Internal links use absolute
// paths starting with `/dashboard/` — `matchRoute` strips the
// prefix before comparing against the pattern table.

export const BASE_PATH = "/dashboard";

/**
 * Module-level navigator: pushes a path onto history and triggers the
 * active router to re-render.
 *
 * Why a singleton instead of taking the `Router` instance everywhere:
 * views need to navigate after async work (an API response, a form
 * submit, a back-from-promise) and threading the router handle through
 * 10 views just to call `.navigate()` was the original CQ H-5 finding
 * — 12+ inlined `history.pushState({}, "", BASE_PATH + "...")` +
 * `dispatchEvent(new PopStateEvent("popstate"))` were spread across
 * the codebase. The first call to `createRouter()` registers itself
 * here; subsequent calls overwrite (last-router-wins, but tests are
 * the only place that creates more than one).
 */
let _activeRouter: Router | null = null;

export function navigate(path: string): void {
  if (_activeRouter !== null) {
    _activeRouter.navigate(path);
    return;
  }
  // Fallback: no router registered yet (e.g. test environment, or
  // a misordered import). Mimic the old behaviour so callers stay
  // crash-free.
  const full = path.startsWith(BASE_PATH) ? path : BASE_PATH + path;
  window.history.pushState({}, "", full);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export interface RouteContext {
  /** The full incoming path under BASE_PATH, e.g. "/devices/123-456-789". */
  path: string;
  /** Path segments after BASE_PATH (e.g. ["devices", "123-456-789"]). */
  segments: string[];
  /** Named params captured by a `:placeholder` segment in the route pattern. */
  params: Record<string, string>;
  /** Parsed query string. */
  query: URLSearchParams;
}

/**
 * A view renderer. May return a cleanup function (clear timers, drop
 * subscriptions); the router invokes it before the next render and on
 * stop() so views can't leak intervals against detached DOM.
 */
export type RouteRenderer = (
  root: HTMLElement,
  ctx: RouteContext,
) => void | (() => void);

export interface Route {
  /**
   * Route pattern: dynamic segments use `:name`. Examples:
   *   "/"            — home page
   *   "/login"       — login page
   *   "/devices/:id" — device detail
   *   "*"            — fallback (matched last)
   */
  pattern: string;
  /** Optional human label shown in the nav (omit for routes that
   * don't appear in the top-bar nav like /verify/:token). */
  navLabel?: string;
  /**
   * Mark routes that require admin privileges. When set, the router
   * substitutes the admin-403 view if `isAdmin()` returns false at
   * render-time, and `buildNav` hides the link altogether. This is
   * UX-only — the backend still enforces with `requireAdmin` on every
   * admin endpoint (gh #53).
   */
  adminOnly?: boolean;
  render: RouteRenderer;
}

export interface MatchResult {
  route: Route;
  params: Record<string, string>;
}

/**
 * Pure helper: pick the first route whose pattern matches `path`.
 * `path` is the path under BASE_PATH, with a leading slash and no
 * query string. `*` always matches last; it's the 404 catch-all.
 */
export function matchRoute(routes: Route[], path: string): MatchResult | null {
  // Normalise — trailing slashes (except the root "/") are dropped
  // so /login and /login/ resolve to the same route.
  const normalised = path === "/" ? "/" : path.replace(/\/+$/, "");
  const segs = normalised === "/" ? [] : normalised.slice(1).split("/");

  for (const route of routes) {
    if (route.pattern === "*") continue;
    const pSegs =
      route.pattern === "/" ? [] : route.pattern.slice(1).split("/");
    if (pSegs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(":")) {
        params[pSegs[i].slice(1)] = decodeSegment(segs[i]);
      } else if (pSegs[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  const fallback = routes.find((r) => r.pattern === "*");
  return fallback ? { route: fallback, params: {} } : null;
}

/**
 * Strip BASE_PATH from a `location.pathname` and return the route
 * path (always starts with `/`). Anything outside BASE_PATH maps to
 * `/` so the home view renders for the root URL too.
 */
export function pathUnderBase(pathname: string, base: string = BASE_PATH): string {
  if (pathname === base || pathname === base + "/") return "/";
  if (pathname.startsWith(base + "/")) {
    return pathname.slice(base.length);
  }
  return "/";
}

/** decodeURIComponent that survives malformed percent-encoding:
 *  crafted/truncated links (e.g. "/devices/50%") would otherwise throw
 *  URIError inside render() with no error boundary — falling back to
 *  the raw segment keeps the router alive. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Replace a node's children with one or more new nodes. Avoids
 *  using innerHTML so the renderer-supplied text content never
 *  reaches the HTML parser (XSS-safe by construction). */
function replaceChildren(node: HTMLElement, child: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(child);
}

export interface Router {
  navigate(path: string): void;
  /** Re-render the current route without touching history — e.g. after
   * the admin state changed and the active view may now differ. */
  refresh(): void;
  start(): void;
  stop(): void;
}

export interface CreateRouterOptions {
  /**
   * Provider for the current admin state. Called on every render so
   * the state reflects an up-to-date probe (e.g. a logout invalidates
   * admin-only views immediately). When omitted, admin gating is
   * disabled (admin-only routes always render).
   */
  isAdmin?: () => boolean;
  /**
   * Renderer for the 403 "kein Admin"-Seite. Substituted in place of
   * the matched route's renderer when `adminOnly` AND `!isAdmin()`.
   * When omitted, the route renders normally and the backend's
   * `requireAdmin` is the only gate (returning a friendly inline 403
   * from the view itself).
   */
  renderAdminForbidden?: RouteRenderer;
}

export function createRouter(
  root: HTMLElement,
  routes: Route[],
  history: History = window.history,
  location: Location = window.location,
  options: CreateRouterOptions = {},
): Router {
  // Register this instance as the active singleton so module-level
  // `navigate(path)` works from any view without threading the
  // router handle through every callsite.
  // (Last-router-wins; tests that build multiple routers should
  // call stop() before constructing a new one.)
  // After a route renders, move focus to the new view's heading so
  // keyboard / screen-reader users are told the page changed (the SPA swaps
  // content without a full navigation). Skipped when the view already moved
  // focus into itself synchronously; form views that focus an input via a
  // microtask still win because that runs after this.
  const focusNewView = (): void => {
    const active = document.activeElement;
    if (active !== null && active !== document.body && root.contains(active)) return;
    const heading = root.querySelector("h1");
    if (heading instanceof HTMLElement) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
  };

  // Cleanup returned by the currently mounted renderer (if any) — run
  // before the next render and on stop() (see RouteRenderer).
  let activeCleanup: (() => void) | null = null;
  const runActiveCleanup = (): void => {
    if (activeCleanup === null) return;
    const cleanup = activeCleanup;
    activeCleanup = null;
    cleanup();
  };

  const render = (): void => {
    runActiveCleanup();
    const path = pathUnderBase(location.pathname);
    const match = matchRoute(routes, path);
    if (!match) {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = "Seite nicht gefunden.";
      replaceChildren(root, p);
      return;
    }
    const segments = path === "/" ? [] : path.slice(1).split("/");
    const ctx: RouteContext = {
      path,
      segments,
      params: match.params,
      query: new URLSearchParams(location.search),
    };
    // Admin-gate: when the matched route is admin-only and the
    // current state isn't admin, render the friendly 403 view instead
    // of the route's normal renderer. Backend still enforces with
    // requireAdmin so this branch is purely UX.
    const useForbidden =
      match.route.adminOnly === true &&
      options.isAdmin !== undefined &&
      !options.isAdmin();
    const cleanup =
      useForbidden && options.renderAdminForbidden
        ? options.renderAdminForbidden(root, ctx)
        : match.route.render(root, ctx);
    activeCleanup = typeof cleanup === "function" ? cleanup : null;
    focusNewView();
    // Notify subscribers (e.g. nav active-state highlighter) that the
    // page just (re-)rendered. Custom event keeps the router decoupled
    // from the nav module.
    window.dispatchEvent(new CustomEvent("dashboard:rendered", { detail: { path } }));
  };

  const onPopState = (): void => render();

  // Intercept internal link clicks so the page doesn't full-reload
  // when navigating between dashboard routes. Named handler so stop()
  // can detach it again.
  const onDocumentClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith(BASE_PATH)) return;
    if (anchor.target === "_blank") return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState({}, "", href);
    render();
  };

  let started = false;

  const router: Router = {
    navigate(path: string): void {
      // Always prefix with BASE_PATH so callers can write
      // navigate("/devices/123") without worrying about the mount
      // point.
      const full = path.startsWith(BASE_PATH) ? path : BASE_PATH + path;
      history.pushState({}, "", full);
      render();
    },
    refresh(): void {
      render();
    },
    start(): void {
      if (started) return;
      started = true;
      window.addEventListener("popstate", onPopState);
      document.addEventListener("click", onDocumentClick);
      render();
    },
    stop(): void {
      started = false;
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick);
      runActiveCleanup();
      if (_activeRouter === router) {
        _activeRouter = null;
      }
    },
  };
  _activeRouter = router;
  return router;
}
