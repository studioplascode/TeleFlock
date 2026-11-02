import type { StateStorage } from "zustand/middleware";

/**
 * `localStorage`, looked up at each call: a persisted store created before the page has one (tests,
 * a store module loaded early) still saves and loads once it exists, and zustand's `persist` always
 * gets a storage, so its API is always there.
 */
export const deviceStorage: StateStorage = {
  getItem: (name) => globalThis.localStorage?.getItem(name) ?? null,
  setItem: (name, value) => globalThis.localStorage?.setItem(name, value),
  removeItem: (name) => globalThis.localStorage?.removeItem(name),
};
