/** Helpers for parsed JSON. No Node APIs. */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality of parsed JSON values. Key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** The value as it ends up in a JSON file: without undefined fields. */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Compare strings by code point, so the order does not depend on the locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** URL-safe identifier: ASCII letters, digits and dashes. */
export function slugify(value: string, limit = 60): string {
  const text = value.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return text.slice(0, limit).replace(/-+$/, "") || "x";
}
