/**
 * Minimal typings for `bun:test` so test files typecheck under the app tsconfig without pulling
 * `@types/bun` globals (which would retype `setTimeout` etc. for the whole program).
 */
declare module "bun:test" {
  interface Matchers<R = void> {
    not: Matchers<R>;
    resolves: Matchers<Promise<R>>;
    rejects: Matchers<Promise<R>>;
    toBe(expected: unknown): R;
    toEqual(expected: unknown): R;
    toStrictEqual(expected: unknown): R;
    toMatchObject(expected: unknown): R;
    toBeDefined(): R;
    toBeUndefined(): R;
    toBeNull(): R;
    toBeTruthy(): R;
    toBeFalsy(): R;
    toBeGreaterThan(n: number): R;
    toBeGreaterThanOrEqual(n: number): R;
    toBeLessThan(n: number): R;
    toBeLessThanOrEqual(n: number): R;
    toBeCloseTo(n: number, digits?: number): R;
    toContain(item: unknown): R;
    toHaveLength(n: number): R;
    toMatch(re: RegExp | string): R;
    toThrow(expected?: unknown): R;
    toHaveProperty(path: string, value?: unknown): R;
  }
  export const expect: {
    (actual: unknown): Matchers;
    stringContaining(sub: string): unknown;
    any(ctor: unknown): unknown;
  };
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
  export const it: typeof test;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export const mock: {
    module(specifier: string, factory: () => Record<string, unknown>): void;
  };
  export const vi: {
    useFakeTimers(): void;
    useRealTimers(): void;
    advanceTimersByTime(ms: number): void;
  };
}
