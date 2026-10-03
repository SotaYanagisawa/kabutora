/** Provider acceleration is optional; eviction never affects persisted market data. */
export function boundedMarketCacheSet<K, V>(cache: Map<K, V>, key: K, value: V, max = 200) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > max) {
        const oldest = cache.keys().next();
        if (oldest.done)
            break;
        cache.delete(oldest.value);
    }
}
