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

export type RouteRenderer = (root: HTMLElement, ctx: RouteContext) => void;

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
        params[pSegs[i].slice(1)] = decodeURIComponent(segs[i]);
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

/** Replace a node's children with one or more new nodes. Avoids
 *  using innerHTML so the renderer-supplied text content never
 *  reaches the HTML parser (XSS-safe by construction). */
function replaceChildren(node: HTMLElement, child: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(child);
}

export interface Router {
  navigate(path: string): void;
  start(): void;
  stop(): void;
}

export function createRouter(
  root: HTMLElement,
  routes: Route[],
  history: History = window.history,
  location: Location = window.location,
): Router {
  const render = (): void => {
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
    match.route.render(root, ctx);
  };

  const onPopState = (): void => render();

  return {
    navigate(path: string): void {
      // Always prefix with BASE_PATH so callers can write
      // navigate("/devices/123") without worrying about the mount
      // point.
      const full = path.startsWith(BASE_PATH) ? path : BASE_PATH + path;
      history.pushState({}, "", full);
      render();
    },
    start(): void {
      window.addEventListener("popstate", onPopState);
      // Intercept internal link clicks so the page doesn't full-reload
      // when navigating between dashboard routes.
      document.addEventListener("click", (e: MouseEvent) => {
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
      });
      render();
    },
    stop(): void {
      window.removeEventListener("popstate", onPopState);
    },
  };
}
