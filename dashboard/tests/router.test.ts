import { describe, it, expect } from "vitest";
import {
  matchRoute,
  pathUnderBase,
  BASE_PATH,
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
