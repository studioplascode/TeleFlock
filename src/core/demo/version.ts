/** The app version Vite injects (vite.config.ts `define`); absent under bun test. */
declare const __APP_VERSION__: string | undefined;

/**
 * The demo's app and tf-hostd version: the build's own, so the demo host is never "too old" for the
 * features its build ships (per-agent roles need hostd ≥ 0.7). "dev" under bun test, which version
 * gates treat as unknown, i.e. supported.
 */
export const DEMO_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
