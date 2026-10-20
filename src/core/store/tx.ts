/**
 * Copy-on-write helper for one reducer pass: the first `own()` of an object clones it, later
 * calls in the same pass return the clone. Many events touching the same session in one frame
 * therefore clone its containers once, and untouched branches keep their identity.
 */
export class Tx {
  private readonly owned = new WeakSet<object>();

  own<T extends object>(value: T): T {
    if (this.owned.has(value)) return value;
    const copy = (Array.isArray(value) ? value.slice() : { ...value }) as T;
    this.owned.add(copy);
    return copy;
  }

  /** Marks a freshly created object as owned (safe to mutate within this pass). */
  fresh<T extends object>(value: T): T {
    this.owned.add(value);
    return value;
  }
}
