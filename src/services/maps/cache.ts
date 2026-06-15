const DEFAULT_CACHE_TTL_MS = Number(process.env.MAPS_PROVIDER_CACHE_TTL_MS ?? 60_000);

export function getCacheTtlMs(): number {
  return Number.isFinite(DEFAULT_CACHE_TTL_MS) && DEFAULT_CACHE_TTL_MS > 0
    ? DEFAULT_CACHE_TTL_MS
    : 60_000;
}

export function cacheGet<T>(cache: Map<string, { expiresAt: number }>, key: string): T | null {
  const entry = cache.get(key) as ({ expiresAt: number } & T) | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry as T;
}

export function cacheSet<T extends Record<string, unknown>>(
  cache: Map<string, { expiresAt: number }>,
  key: string,
  value: T
): void {
  cache.set(key, { ...value, expiresAt: Date.now() + getCacheTtlMs() });
}
