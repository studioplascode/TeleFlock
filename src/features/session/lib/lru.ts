/**
 * Bounded memo for pure, string-keyed parsers (markdown, ANSI, diff, syntax tokens). Rows that
 * scroll back into the virtualised transcript re-mount; with this they skip re-parsing. Results are
 * shared, so callers must treat them as immutable.
 */
export function lruMemo<V>(max: number, compute: (key: string) => V): (key: string) => V {
  const cache = new Map<string, V>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Refresh recency.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const value = compute(key);
    cache.set(key, value);
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return value;
  };
}
