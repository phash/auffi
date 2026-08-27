import { vi } from "vitest";

/**
 * jsdom 29 does not ship localStorage in our vitest environment, so any test
 * touching a persistence path has to provide one. Installs a Map-backed
 * Storage as the global, so the code under test exercises its real
 * persistence branch instead of the try/catch fallback.
 *
 * Returns the backing map for assertions that need to inspect or seed it.
 */
export function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
  vi.stubGlobal("localStorage", stub);
  return store;
}
