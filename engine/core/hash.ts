/**
 * Short, stable hash for ids. FNV-1a over UTF-8, 32 bits as 8 hex digits. Not for security: it only
 * tells apart tariffs that share a name. Synchronous and without Node APIs, unlike Web Crypto.
 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
